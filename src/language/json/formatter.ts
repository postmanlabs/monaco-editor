/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as json from 'jsonc-parser';
import * as jsonService from 'vscode-json-languageservice';

export function format(d, r, o) {
	let range: json.Range | undefined = undefined;
	if (r) {
		const offset = d.offsetAt(r.start);
		const length = d.offsetAt(r.end) - offset;
		range = { offset, length };
	}
	const options = {
		tabSize: o ? o.tabSize : 4,
		insertSpaces: o ? o.insertSpaces : true,
		eol: '\n'
	};
	return formatJSON(d.getText(), range, options).map((e) => {
		return jsonService.TextEdit.replace(
			jsonService.Range.create(d.positionAt(e.offset), d.positionAt(e.offset + e.length)),
			e.content
		);
	});
}

function formatJSON(
	documentText: string,
	range: json.Range | undefined,
	options: json.FormattingOptions
): json.Edit[] {
	let initialIndentLevel: number;
	let formatText: string;
	let formatTextStart: number;
	let rangeStart: number;
	let rangeEnd: number;
	if (range) {
		rangeStart = range.offset;
		rangeEnd = rangeStart + range.length;

		formatTextStart = rangeStart;
		while (formatTextStart > 0 && !isEOL(documentText, formatTextStart - 1)) {
			formatTextStart--;
		}
		let endOffset = rangeEnd;
		while (endOffset < documentText.length && !isEOL(documentText, endOffset)) {
			endOffset++;
		}
		formatText = documentText.substring(formatTextStart, endOffset);
		initialIndentLevel = computeIndentLevel(formatText, options);
	} else {
		formatText = documentText;
		initialIndentLevel = 0;
		formatTextStart = 0;
		rangeStart = 0;
		rangeEnd = documentText.length;
	}
	let eol = getEOL(options, documentText);

	let lineBreak = false;
	let indentLevel = 0;
	let indentValue: string;
	if (options.insertSpaces) {
		indentValue = repeat(' ', options.tabSize || 4);
	} else {
		indentValue = '\t';
	}

	let scanner = json.createScanner(formatText, false);
	let hasError = false;

	function newLineAndIndent(): string {
		return eol + repeat(indentValue, initialIndentLevel + indentLevel);
	}
	function scanNext(): json.SyntaxKind {
		let token = scanner.scan();
		lineBreak = false;
		while (token === json.SyntaxKind.Trivia || token === json.SyntaxKind.LineBreakTrivia) {
			lineBreak = lineBreak || token === json.SyntaxKind.LineBreakTrivia;
			token = scanner.scan();
		}
		hasError = token === json.SyntaxKind.Unknown || scanner.getTokenError() !== json.ScanError.None;
		return token;
	}
	let editOperations: json.Edit[] = [];
	function addEdit(text: string, startOffset: number, endOffset: number) {
		if (
			!hasError &&
			startOffset < rangeEnd &&
			endOffset > rangeStart &&
			documentText.substring(startOffset, endOffset) !== text
		) {
			editOperations.push({ offset: startOffset, length: endOffset - startOffset, content: text });
		}
	}

	let firstToken = scanNext();

	if (firstToken !== json.SyntaxKind.EOF) {
		let firstTokenStart = scanner.getTokenOffset() + formatTextStart;
		let initialIndent = repeat(indentValue, initialIndentLevel);
		addEdit(initialIndent, formatTextStart, firstTokenStart);
	}

	function getPostmanVariablePosition() {
		let startPosition = scanner.getTokenOffset() + formatTextStart - 1; // because we had advanced one position to fetch the next character to get second token
		let textFromCurrentPosition = formatText.substring(startPosition);
		let position = 0;
		while (position <= textFromCurrentPosition.length) {
			if (position === textFromCurrentPosition.length) {
				break;
			}
			let scanned = textFromCurrentPosition[position];
			if (scanned === ':' || scanned === ',' || scanned === ']' || isEOL(scanned, 0)) {
				break;
			}
			position++;
		}

		let text = textFromCurrentPosition.substring(0, position);
		let textLength = text.length;
		if (!textLength) {
			return null;
		}

		let stack = [],
			matched = [],
			minStartIndex = Infinity,
			maxEndIndex = -Infinity;
		position = 0;
		while (position < textLength) {
			let current = text[position];
			if (current === '{') {
				stack.push({ startIndex: startPosition + position, endIndex: null });
			} else if (current === '}' && position + 1 < textLength && text[position + 1] === '}') {
				let firstPop = null,
					secondPop = null,
					toBeInsertedPop = null;
				while (stack.length >= 0) {
					if (firstPop === null) {
						firstPop = stack.pop();
						if (!firstPop) {
							break;
						}
					}
					secondPop = stack.pop();
					if (!secondPop) {
						break;
					}

					if (firstPop.startIndex === secondPop.startIndex + 1) {
						toBeInsertedPop = secondPop;
						firstPop = null;
						secondPop = null;
					} else {
						firstPop = secondPop;
					}
					if (toBeInsertedPop) {
						toBeInsertedPop.endIndex = startPosition + position + 1;

						minStartIndex = Math.min(minStartIndex, toBeInsertedPop.startIndex);
						maxEndIndex = Math.max(maxEndIndex, toBeInsertedPop.endIndex);

						matched.push(toBeInsertedPop);
						toBeInsertedPop = null;
						position++;
						break;
					}
				}
			}
			position++;
		}

		if (matched.length) {
			if (minStartIndex !== startPosition) {
				return null;
			}
			scanner.setPosition(maxEndIndex);
			scanner.scan();
			return { startIndex: startPosition, endIndex: maxEndIndex };
		}
	}

	while (firstToken !== json.SyntaxKind.EOF) {
		let firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
		let secondToken = scanNext();

		//search for postman variable
		if (!lineBreak && firstToken === json.SyntaxKind.OpenBraceToken && firstToken === secondToken) {
			let position = getPostmanVariablePosition();
			if (position) {
				firstToken = json.SyntaxKind.StringLiteral;
				firstTokenEnd = position.endIndex + 1;
				secondToken = scanNext();
			}
		}

		let replaceContent = '';
		while (
			!lineBreak &&
			(secondToken === json.SyntaxKind.LineCommentTrivia ||
				secondToken === json.SyntaxKind.BlockCommentTrivia)
		) {
			// comments on the same line: keep them on the same line, but ignore them otherwise
			let commentTokenStart = scanner.getTokenOffset() + formatTextStart;
			addEdit(' ', firstTokenEnd, commentTokenStart);
			firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
			replaceContent = secondToken === json.SyntaxKind.LineCommentTrivia ? newLineAndIndent() : '';
			secondToken = scanNext();
		}

		if (secondToken === json.SyntaxKind.CloseBraceToken) {
			if (firstToken !== json.SyntaxKind.OpenBraceToken) {
				indentLevel--;
				replaceContent = newLineAndIndent();
			}
		} else if (secondToken === json.SyntaxKind.CloseBracketToken) {
			if (firstToken !== json.SyntaxKind.OpenBracketToken) {
				indentLevel--;
				replaceContent = newLineAndIndent();
			}
		} else {
			switch (firstToken) {
				case json.SyntaxKind.OpenBracketToken:
				case json.SyntaxKind.OpenBraceToken:
					indentLevel++;
					replaceContent = newLineAndIndent();
					break;
				case json.SyntaxKind.CommaToken:
				case json.SyntaxKind.LineCommentTrivia:
					replaceContent = newLineAndIndent();
					break;
				case json.SyntaxKind.BlockCommentTrivia:
					if (lineBreak) {
						replaceContent = newLineAndIndent();
					} else {
						// symbol following comment on the same line: keep on same line, separate with ' '
						replaceContent = ' ';
					}
					break;
				case json.SyntaxKind.ColonToken:
					replaceContent = ' ';
					break;
				case json.SyntaxKind.StringLiteral:
					if (secondToken === json.SyntaxKind.ColonToken) {
						replaceContent = '';
						break;
					}
				// fall through
				case json.SyntaxKind.NullKeyword:
				case json.SyntaxKind.TrueKeyword:
				case json.SyntaxKind.FalseKeyword:
				case json.SyntaxKind.NumericLiteral:
				case json.SyntaxKind.CloseBraceToken:
				case json.SyntaxKind.CloseBracketToken:
					if (
						secondToken === json.SyntaxKind.LineCommentTrivia ||
						secondToken === json.SyntaxKind.BlockCommentTrivia
					) {
						replaceContent = ' ';
					} else if (
						secondToken !== json.SyntaxKind.CommaToken &&
						secondToken !== json.SyntaxKind.EOF
					) {
						hasError = true;
					}
					break;
				case json.SyntaxKind.Unknown:
					hasError = true;
					break;
			}
			if (
				lineBreak &&
				(secondToken === json.SyntaxKind.LineCommentTrivia ||
					secondToken === json.SyntaxKind.BlockCommentTrivia)
			) {
				replaceContent = newLineAndIndent();
			}
		}
		let secondTokenStart = scanner.getTokenOffset() + formatTextStart;
		addEdit(replaceContent, firstTokenEnd, secondTokenStart);
		firstToken = secondToken;
	}
	return editOperations;
}

function repeat(s: string, count: number): string {
	let result = '';
	for (let i = 0; i < count; i++) {
		result += s;
	}
	return result;
}

function computeIndentLevel(content: string, options: json.FormattingOptions): number {
	let i = 0;
	let nChars = 0;
	let tabSize = options.tabSize || 4;
	while (i < content.length) {
		let ch = content.charAt(i);
		if (ch === ' ') {
			nChars++;
		} else if (ch === '\t') {
			nChars += tabSize;
		} else {
			break;
		}
		i++;
	}
	return Math.floor(nChars / tabSize);
}

function getEOL(options: json.FormattingOptions, text: string): string {
	for (let i = 0; i < text.length; i++) {
		let ch = text.charAt(i);
		if (ch === '\r') {
			if (i + 1 < text.length && text.charAt(i + 1) === '\n') {
				return '\r\n';
			}
			return '\r';
		} else if (ch === '\n') {
			return '\n';
		}
	}
	return (options && options.eol) || '\n';
}

export function isEOL(text: string, offset: number) {
	return '\r\n'.indexOf(text.charAt(offset)) !== -1;
}
