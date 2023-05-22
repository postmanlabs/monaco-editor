/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as json from 'jsonc-parser';
import { languages } from '../../fillers/monaco-editor-core';

export function createTokenizationSupport(
	supportComments: boolean,
	languageId?: string
): languages.TokensProvider {
	return {
		getInitialState: () => new JSONState(null, null, false, null),
		tokenize: (line, state?) => tokenize(supportComments, line, <JSONState>state, 0, languageId)
	};
}

export const TOKEN_DELIM_OBJECT = 'delimiter.bracket.json';
export const TOKEN_DELIM_ARRAY = 'delimiter.array.json';
export const TOKEN_DELIM_COLON = 'delimiter.colon.json';
export const TOKEN_DELIM_COMMA = 'delimiter.comma.json';
export const TOKEN_VALUE_BOOLEAN = 'keyword.json';
export const TOKEN_VALUE_NULL = 'keyword.json';
export const TOKEN_VALUE_STRING = 'string.value.json';
export const TOKEN_VALUE_NUMBER = 'number.json';
export const TOKEN_PROPERTY_NAME = 'string.key.json';
export const TOKEN_COMMENT_BLOCK = 'comment.block.json';
export const TOKEN_COMMENT_LINE = 'comment.line.json';
export const TOKEN_POSTMAN_VARIABLE = 'postman.variable.json';
export const TOKEN_POSTMAN_VARIABLE_IN_STRING = 'postman.variable.string.json';

const enum JSONParent {
	Object = 0,
	Array = 1
}

class ParentsStack {
	constructor(public readonly parent: ParentsStack | null, public readonly type: JSONParent) {}

	public static pop(parents: ParentsStack | null): ParentsStack | null {
		if (parents) {
			return parents.parent;
		}
		return null;
	}

	public static push(parents: ParentsStack | null, type: JSONParent): ParentsStack {
		return new ParentsStack(parents, type);
	}

	public static equals(a: ParentsStack | null, b: ParentsStack | null): boolean {
		if (!a && !b) {
			return true;
		}
		if (!a || !b) {
			return false;
		}
		while (a && b) {
			if (a === b) {
				return true;
			}
			if (a.type !== b.type) {
				return false;
			}
			a = a.parent;
			b = b.parent;
		}
		return true;
	}
}

export class JSONState implements languages.IState {
	private _state: languages.IState | null;

	public scanError: ScanError | null;
	public lastWasColon: boolean;
	public parents: ParentsStack | null;

	constructor(
		state: languages.IState | null,
		scanError: ScanError | null,
		lastWasColon: boolean,
		parents: ParentsStack | null
	) {
		this._state = state;
		this.scanError = scanError;
		this.lastWasColon = lastWasColon;
		this.parents = parents;
	}

	public clone(): JSONState {
		return new JSONState(this._state, this.scanError, this.lastWasColon, this.parents);
	}

	public equals(other: languages.IState): boolean {
		if (other === this) {
			return true;
		}
		if (!other || !(other instanceof JSONState)) {
			return false;
		}
		return (
			this.scanError === other.scanError &&
			this.lastWasColon === other.lastWasColon &&
			ParentsStack.equals(this.parents, other.parents)
		);
	}

	public getStateData(): languages.IState | null {
		return this._state;
	}

	public setStateData(state: languages.IState): void {
		this._state = state;
	}
}

const enum ScanError {
	None = 0,
	UnexpectedEndOfComment = 1,
	UnexpectedEndOfString = 2,
	UnexpectedEndOfNumber = 3,
	InvalidUnicode = 4,
	InvalidEscapeCharacter = 5,
	InvalidCharacter = 6
}

const enum SyntaxKind {
	OpenBraceToken = 1,
	CloseBraceToken = 2,
	OpenBracketToken = 3,
	CloseBracketToken = 4,
	CommaToken = 5,
	ColonToken = 6,
	NullKeyword = 7,
	TrueKeyword = 8,
	FalseKeyword = 9,
	StringLiteral = 10,
	NumericLiteral = 11,
	LineCommentTrivia = 12,
	BlockCommentTrivia = 13,
	LineBreakTrivia = 14,
	Trivia = 15,
	Unknown = 16,
	EOF = 17
}

export function tokenize(
	comments: boolean,
	line: string,
	state: JSONState,
	offsetDelta: number = 0,
	languageId?: string
): languages.ILineTokens {
	// handle multiline strings and block comments
	let numberOfInsertedCharacters = 0;
	let adjustOffset = false;

	switch (state.scanError) {
		case ScanError.UnexpectedEndOfString:
			line = '"' + line;
			numberOfInsertedCharacters = 1;
			break;
		case ScanError.UnexpectedEndOfComment:
			line = '/*' + line;
			numberOfInsertedCharacters = 2;
			break;
	}

	const scanner = json.createScanner(line);
	let lastWasColon = state.lastWasColon;
	let parents = state.parents;
	let openBracesCount = 0;

	const ret: languages.ILineTokens = {
		tokens: <languages.IToken[]>[],
		endState: state.clone()
	};

	while (true) {
		let offset = offsetDelta + scanner.getPosition();
		let type = '',
			skip = false;
		let postmanVariablesInString = <languages.IToken[]>[];

		const kind = <SyntaxKind>(<any>scanner.scan());
		if (kind === SyntaxKind.EOF) {
			break;
		}

		// Check that the scanner has advanced
		if (offset === offsetDelta + scanner.getPosition()) {
			throw new Error(
				'Scanner did not advance, next 3 characters are: ' + line.substr(scanner.getPosition(), 3)
			);
		}

		// In case we inserted /* or " character, we need to
		// adjust the offset of all tokens (except the first)
		if (adjustOffset) {
			offset -= numberOfInsertedCharacters;
		}
		adjustOffset = numberOfInsertedCharacters > 0;

		if (kind === SyntaxKind.OpenBraceToken) {
			openBracesCount++;
		} else {
			openBracesCount = 0;
		}

		// brackets and type
		switch (kind) {
			case SyntaxKind.OpenBraceToken:
				parents = ParentsStack.push(parents, JSONParent.Object);
				if (openBracesCount === 2 && languageId === 'postman_json') {
					let stringFromDoubleBraces = line.substr(scanner.getPosition() - 2) + '\n';
					let delimiterIndex = findClosestDelimiter(stringFromDoubleBraces, [',', ':', ']', '\n']);
					if (delimiterIndex >= 0) {
						let delimitedString = stringFromDoubleBraces.substring(0, delimiterIndex);
						let tokens = createPostmanVariableScanner(
							delimitedString,
							offset - 1,
							lastWasColon,
							false
						);
						if (tokens.length) {
							ret.tokens.pop();
							ret.tokens = ret.tokens.concat(tokens);
							// set the position till the last index of postman var token created
							const tokenArray = tokens[tokens.length - 1] as any;
							scanner.setPosition(tokenArray.endIndex + 1);
							// As we have added the two opening braces inside the stack, but this turned out to be
							// a postman variable, we remove last two elements, as the 2 closing braces of the Postman variable will not be
							// encountered because the scanner's position has been set after the closing braces.
							parents = ParentsStack.pop(parents);
							parents = ParentsStack.pop(parents);
							skip = true;
						}
					} else {
						type = TOKEN_DELIM_OBJECT;
					}
				} else {
					type = TOKEN_DELIM_OBJECT;
				}
				lastWasColon = false;
				break;
			case SyntaxKind.CloseBraceToken:
				parents = ParentsStack.pop(parents);
				type = TOKEN_DELIM_OBJECT;
				lastWasColon = false;
				break;
			case SyntaxKind.OpenBracketToken:
				parents = ParentsStack.push(parents, JSONParent.Array);
				type = TOKEN_DELIM_ARRAY;
				lastWasColon = false;
				break;
			case SyntaxKind.CloseBracketToken:
				parents = ParentsStack.pop(parents);
				type = TOKEN_DELIM_ARRAY;
				lastWasColon = false;
				break;
			case SyntaxKind.ColonToken:
				type = TOKEN_DELIM_COLON;
				lastWasColon = true;
				break;
			case SyntaxKind.CommaToken:
				type = TOKEN_DELIM_COMMA;
				lastWasColon = false;
				break;
			case SyntaxKind.TrueKeyword:
			case SyntaxKind.FalseKeyword:
				type = TOKEN_VALUE_BOOLEAN;
				lastWasColon = false;
				break;
			case SyntaxKind.NullKeyword:
				type = TOKEN_VALUE_NULL;
				lastWasColon = false;
				break;
			case SyntaxKind.StringLiteral:
				const currentParent = parents ? parents.type : JSONParent.Object;
				const inArray = currentParent === JSONParent.Array;
				let inValue = lastWasColon || inArray;
				if (languageId === 'postman_json') {
					// get the token value from the current line that is being tokenized and not from scanner.getTokenValue,
					// as the later returns the escaped value of the string.
					// Substring the current line from the one index after the current token offset to skip the opening double quote
					// The length of string should be the token length - 2, as the token contains both opening and closing quotes.
					let tokenValue = line.substr(scanner.getTokenOffset() + 1, scanner.getTokenLength() - 2);
					postmanVariablesInString = createPostmanVariableScanner(
						tokenValue,
						offset + 1,
						inValue,
						true
					);
				}
				type = inValue || inArray ? TOKEN_VALUE_STRING : TOKEN_PROPERTY_NAME;
				lastWasColon = false;
				break;
			case SyntaxKind.NumericLiteral:
				type = TOKEN_VALUE_NUMBER;
				lastWasColon = false;
				break;
		}

		// comments, iff enabled
		if (comments) {
			switch (kind) {
				case SyntaxKind.LineCommentTrivia:
					type = TOKEN_COMMENT_LINE;
					break;
				case SyntaxKind.BlockCommentTrivia:
					type = TOKEN_COMMENT_BLOCK;
					break;
			}
		}

		ret.endState = new JSONState(
			state.getStateData(),
			<ScanError>(<any>scanner.getTokenError()),
			lastWasColon,
			parents
		);
		if (!skip) {
			ret.tokens.push({
				startIndex: offset,
				scopes: type
			});
		}
		if (postmanVariablesInString.length) {
			ret.tokens = ret.tokens.concat(postmanVariablesInString);
		}
	}

	return ret;
}

function createPostmanVariableScanner(
	stringLiteral: string,
	offset: number,
	inValue: Boolean = false,
	inString: Boolean = false
) {
	let length = stringLiteral.length;
	let pos = 0;
	let stack = [];
	let matchedBrackets = [];
	let scannedResults = [];
	while (pos < length) {
		let current = stringLiteral[pos];
		if (current === '{') {
			stack.push({ startIndex: offset + pos, scopes: '', endIndex: 0 });
		} else if (current === '}' && pos + 1 < length && stringLiteral[pos + 1] === '}') {
			let currentPopped = null,
				nextPopped = null,
				toBeInsertedPopped = null;
			while (stack.length >= 0) {
				if (currentPopped === null) {
					currentPopped = stack.pop();
					if (!currentPopped) break;
				}
				nextPopped = stack.pop();
				if (!nextPopped) break;
				if (currentPopped.startIndex === nextPopped.startIndex + 1) {
					toBeInsertedPopped = nextPopped;
					currentPopped = null;
					nextPopped = null;
				} else {
					currentPopped = nextPopped;
				}
				if (toBeInsertedPopped) {
					toBeInsertedPopped.scopes = inString
						? TOKEN_POSTMAN_VARIABLE_IN_STRING
						: TOKEN_POSTMAN_VARIABLE;
					toBeInsertedPopped.endIndex = offset + pos + 1;
					matchedBrackets.push(toBeInsertedPopped);
					toBeInsertedPopped = null;
					pos++;
					break;
				}
			}
		}
		pos++;
	}
	if (matchedBrackets.length) {
		// sort the matched tokens on the start index
		matchedBrackets.sort((a, b) => {
			return a.startIndex - b.startIndex;
		});

		//remove nested brackets
		let filteredBrackets = [];
		let endIndexOfLastFilteredBracket = -1;
		for (let i = 0; i < matchedBrackets.length; i++) {
			if (matchedBrackets[i].startIndex > endIndexOfLastFilteredBracket) {
				filteredBrackets.push(matchedBrackets[i]);
				endIndexOfLastFilteredBracket = matchedBrackets[i].endIndex;
			}
		}

		let endIndexLastTokenCreated = -1; // store the end index of the last token created

		// create string token if postman var doesnt appear at the start of the string
		// eg. "abc {{pv}}" --> token for abc will be created
		if (inString && filteredBrackets[0].startIndex !== offset) {
			scannedResults.push({
				startIndex: offset,
				endIndex: filteredBrackets[0].startIndex - 1,
				scopes: inValue ? TOKEN_VALUE_STRING : TOKEN_PROPERTY_NAME
			});
			endIndexLastTokenCreated = filteredBrackets[0].startIndex - 1;
		}

		for (let i = 0; i < filteredBrackets.length; i++) {
			let current = filteredBrackets[i];
			let next = filteredBrackets[i + 1];

			// the new token to be created should have a start index greater than end index of the last created token
			if (endIndexLastTokenCreated < current.startIndex) {
				scannedResults.push(current);
				endIndexLastTokenCreated = current.endIndex;
			}

			if (!next || (next && next.startIndex === current.endIndex + 1)) {
				continue;
			}

			// create tokens for string not part of postman var but appearing between two postman vars
			// eg "{{pv1}} abc {{pv2}}" --> token for abc will be created
			inString &&
				scannedResults.push({
					startIndex: current.endIndex + 1,
					endIndex: next.startIndex - 1,
					scopes: inValue ? TOKEN_VALUE_STRING : TOKEN_PROPERTY_NAME
				});
			endIndexLastTokenCreated = next.startIndex - 1;
		}

		// create tokens for remaining part of the strings after the tokens for all postman vars is created
		//eg. "{{pv1}} abc {{pv2}} def" --> token for def will be created
		if (endIndexLastTokenCreated < offset + length && inString) {
			scannedResults.push({
				startIndex: endIndexLastTokenCreated + 1,
				scopes: inValue ? TOKEN_VALUE_STRING : TOKEN_PROPERTY_NAME
			});
		}
	}
	return scannedResults;
}

function findClosestDelimiter(stringLiteral: string, delimiter: string[]): number {
	length = delimiter.length;
	if (length === 0) return -1;
	let leastIndex = Infinity;
	for (let i = 0; i < length; i++) {
		let index = stringLiteral.indexOf(delimiter[i]);
		if (leastIndex > index && index > -1) {
			leastIndex = index;
		}
	}
	return leastIndex !== Infinity ? leastIndex : -1;
}
