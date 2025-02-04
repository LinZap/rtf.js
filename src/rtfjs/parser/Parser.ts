/*

The MIT License (MIT)

Copyright (c) 2015 Thomas Bluemel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/

import cptable from "codepage";
import { Document } from "../Document";
import { Helper, RTFJSError } from "../Helper";
import { RenderChp } from "../renderer/RenderChp";
import { Renderer } from "../renderer/Renderer";
import { RenderPap } from "../renderer/RenderPap";
import { SymbolTable } from "../Symboltable";
import { GlobalState, State } from "./Containers";
import { DestinationFactory } from "./destinations/DestinationBase";
import { Destinations } from "./destinations/Destinations";

export class Parser {
    private inst: Document;
    private parser: GlobalState;

    constructor(document: Document, blob: ArrayBuffer, renderer: Renderer) {
        this.inst = document;
        this.parser = new GlobalState(blob, renderer);
    }

    public parse(): Promise<void> {
        if (this.parser.data.length > 1 && String.fromCharCode(this.parser.data[0]) === "{") {
            this.parseLoop(false, true);
            return Promise.all(this.parser._asyncTasks).then(() => { return; });
        }
        if (this.parser.version == null) {
            throw new RTFJSError("Not a valid rtf document");
        }
        if (this.parser.state != null) {
            throw new RTFJSError("File truncated");
        }
    }

    private eof() {
        return this.parser.pos >= this.parser.data.length;
    }

    private readChar() {
        if (this.parser.pos < this.parser.data.length) {
            this.parser.column++;
            return String.fromCharCode(this.parser.data[this.parser.pos++]);
        }

        throw new RTFJSError("Unexpected end of file");
    }

    private unreadChar() {
        if (this.parser.pos > 0) {
            this.parser.column--;
            this.parser.pos--;
        } else {
            throw new RTFJSError("Already at beginning of file");
        }
    }

    private readBlob(cnt: number) {
        if (this.parser.pos + cnt > this.parser.data.length) {
            throw new RTFJSError("Cannot read binary data: too long");
        }
        const buf = new ArrayBuffer(cnt);
        const view = new Uint8Array(buf);
        for (let i = 0; i < cnt; i++) {
            view[i] = this.parser.data[this.parser.pos + i];
        }
        return buf;
    }

    private applyDestination(always: boolean) {
        const dest = this.parser.state.destination;
        if (dest != null) {
            if (always || this.parser.state.parent == null
                || this.parser.state.parent.destination !== this.parser.state.destination) {
                if (dest.apply != null) {
                    dest.apply();
                }
                this.parser.state.destination = null;
            }
        }
    }

    private applyText() {
        if (this.parser.text.length > 0) {
            const dest = this.parser.state.destination;
            if (dest == null) {
                throw new RTFJSError("Cannot route text to destination");
            }
            if (dest != null && dest.appendText != null && !this.parser.state.skipdestination) {
                dest.appendText(this.parser.text);
            }
            this.parser.text = "";
        }
    }

    private pushState(forceSkip: boolean) {
        this.parser.state = new State(this.parser.state);
        if (forceSkip) {
            this.parser.state.skipdestination = true;
        }

        const dest = this.parser.state.destination;
        if (dest != null && !this.parser.state.skipdestination) {
            if (dest.sub != null) {
                const sub = dest.sub();
                if (sub != null) {
                    this.parser.state.destination = sub;
                }
            }
        }
    }

    private popState() {
        const state = this.parser.state;
        if (state == null) {
            throw new RTFJSError("Unexpected end of state");
        }

        this.applyText();
        if (state.parent == null || state.destination !== state.parent.destination) {
            this.applyDestination(true);
        }
        this.parser.state = state.parent;

        if (this.parser.state !== null) {
            const currentState = this.parser.state;
            this.inst._ins.push((renderer) => {
                renderer.setChp(new RenderChp(currentState.chp));
            });
            this.inst._ins.push((renderer) => {
                renderer.setPap(new RenderPap(currentState.pap));
            });
        }
        return this.parser.state;
    }

    private changeDestination(name: string, param: number) {
        this.applyText();
        const handler = Destinations[name];
        if (handler != null) {
            this.applyDestination(false);
            if (handler instanceof DestinationFactory) {
                this.parser.state.destination = handler.newDestination(this.parser, this.inst, name, param);
            } else {
                this.parser.state.destination = new handler(this.parser, this.inst, name, param);
            }
            return true;
        }
        return false;
    }

    private processKeyword(keyword: string, param: number) {
        const first = this.parser.state.first;
        if (first) {
            if (keyword === "*") {
                this.parser.state.skipunknowndestination = true;
                return;
            }

            this.parser.state.first = false;
        }

        if (this.parser.state.bindata > 0) {
            throw new RTFJSError("Keyword encountered within binary data");
        }

        // Reset if we unexpectedly encounter a keyword
        this.parser.state.skipchars = 0;
        switch (keyword) {
            case "\n":
                return "\n";
            case "\r":
                return "\r";
            case "tab":
                return "\t";
            case "ldblquote":
                return "“";
            case "rdblquote":
                return "”";
            case "{":
            case "}":
            case "\\":
                return keyword;

            case "uc":
                if (param != null && param >= 0) {
                    this.parser.state.ucn = param;
                }
                break;
            case "u":
                if (param != null) {
                    if (param < 0) {
                        param += 65536;
                    }
                    if (param < 0 || param > 65535) {
                        throw new RTFJSError("Invalid unicode character encountered");
                    }

                    const symbol = SymbolTable[param.toString(16).substring(2)];
                    this.appendText(symbol !== undefined ? symbol : String.fromCharCode(param));
                    this.parser.state.skipchars = this.parser.state.ucn;
                }
                return;

            case "bin":
                if (param == null) {
                    throw new RTFJSError("Binary data is missing length");
                }
                if (param < 0) {
                    throw new RTFJSError("Binary data with invalid length");
                }
                this.parser.state.bindata = param;
                return;

            case "upr":
                this.parseLoop(true, false); // skip the first sub destination (ansi)
                // this will be followed by a \ud sub destination
                return;
            case "ud":
                return;

            default:
                if (!this.parser.state.skipdestination) {
                    if (first) {
                        if (!this.changeDestination(keyword, param)) {
                            let handled = false;
                            const dest = this.parser.state.destination;
                            if (dest != null) {
                                if (dest.handleKeyword != null) {
                                    handled = dest.handleKeyword(keyword, param) || false;
                                }
                            }
                            if (!handled && this.parser.state.skipunknowndestination) {
                                this.parser.state.skipdestination = true;
                            }
                        }
                    } else {
                        this.applyText();
                        const dest = this.parser.state.destination;
                        if (dest != null) {
                            if (dest.handleKeyword != null) {
                                dest.handleKeyword(keyword, param);
                            }
                        } else {
                            Helper.log("Unhandled keyword: " + keyword + " param: " + param);
                        }
                    }
                }
                return;
        }

        this.parser.state.skipdestination = false;
    }

    private appendText(text: string) {
        // Handle characters not found in codepage
        text = text ? text : "";

        this.parser.state.first = false;
        if (this.parser.state.skipchars > 0) {
            const len = text.length;
            if (this.parser.state.skipchars >= len) {
                this.parser.state.skipchars -= len;
                return;
            }

            if (this.parser.state.destination == null || !this.parser.state.skipdestination) {
                this.parser.text += text.slice(this.parser.state.skipchars);
            }
            this.parser.state.skipchars = 0;
        } else if (this.parser.state.destination == null || !this.parser.state.skipdestination) {
            this.parser.text += text;
        }
    }

    private applyBlob(blob: ArrayBuffer) {
        this.parser.state.first = false;
        this.applyText();
        if (this.parser.state.skipchars > 0) {
            // \bin and all its data is considered one character for skipping purposes
            this.parser.state.skipchars--;
        } else {
            const dest = this.parser.state.destination;
            if (dest == null) {
                throw new RTFJSError("Cannot route binary to destination");
            }
            if (dest != null && dest.handleBlob != null && !this.parser.state.skipdestination) {
                dest.handleBlob(blob);
            }
        }
    }

    private parseKeyword(process: boolean) {
        if (this.parser.state == null) {
            throw new RTFJSError("No state");
        }

        let param: number;
        let ch = this.readChar();
        if (!Helper._isalpha(ch)) {
            if (ch === "\'") {
                let hex = this.readChar() + this.readChar();
                if(hex.indexOf('\\')) return
                if (this.parser.state.pap.charactertype === Helper.CHARACTER_TYPE.DOUBLE) {
                    this.readChar();
                    this.readChar();
                    hex += this.readChar() + this.readChar();
                }
                param = Helper._parseHex(hex);
                if (isNaN(param)) {
                    throw new RTFJSError("Could not parse hexadecimal number");
                }

                if (process) {
                    // Looking for current fonttbl charset
                    let codepage = this.parser.codepage;
                    if (this.parser.state.chp.hasOwnProperty("fontfamily")) {
                        const idx = this.parser.state.chp.fontfamily;
                        if (this.inst._fonts !== undefined && this.inst._fonts[idx] != null
                            && this.inst._fonts[idx].charset !== undefined && this.inst._fonts[idx].charset != null) {
                            codepage = this.inst._fonts[idx].charset;
                        }
                    }

                    this.appendText(cptable[codepage].dec[param]);
                }
            } else if (process) {
                const text = this.processKeyword(ch, param);
                if (text != null) {
                    this.appendText(text);
                }
            }
        } else {
            let keyword = ch;
            ch = this.readChar();
            while (keyword.length < 30 && Helper._isalpha(ch)) {
                keyword += ch;
                ch = this.readChar();
            }

            let num;
            if (ch === "-") {
                num = "-";
                ch = this.readChar();
            } else {
                num = "";
            }

            if (Helper._isdigit(ch)) {
                do {
                    num += ch;
                    ch = this.readChar();
                } while (num.length < 20 && Helper._isdigit(ch));

                if (num.length >= 20) {
                    throw new RTFJSError("Param for keyword " + keyword + " too long");
                }

                param = parseInt(num, 10);
                if (isNaN(param)) {
                    throw new RTFJSError("Invalid keyword " + keyword + " param");
                }
            }

            if (ch !== " ") {
                this.unreadChar();
            }

            if (process) {
                const text = this.processKeyword(keyword, param);
                if (text != null) {
                    this.appendText(text);
                }
            }
        }
    }

    private parseLoop(skip: boolean, process: boolean) {
        try {
            const initialState = this.parser.state;
            main_loop: while (!this.eof()) {
                if (this.parser.state != null && this.parser.state.bindata > 0) {
                    const blob = this.readBlob(this.parser.state.bindata);
                    this.parser.state.bindata = 0;
                    this.applyBlob(blob);
                } else {
                    const ch = this.readChar();
                    switch (ch) {
                        case "\r":
                            continue;
                        case "\n":
                            this.parser.line++;
                            this.parser.column = 0;
                            continue;
                        case "{":
                            this.pushState(skip);
                            break;
                        case "}":
                            if (initialState === this.parser.state) {
                                this.unreadChar();
                                break main_loop;
                            } else if (this.popState() === initialState) {
                                break main_loop;
                                 }
                            break;
                        case "\\":
                            this.parseKeyword(!skip ? process : null);
                            break;
                        default:
                            if (!skip) {
                                this.appendText(ch);
                            }
                            break;
                    }
                }
            }
        } catch (error) {
            if (error instanceof RTFJSError) {
                error.message += " (line: " + this.parser.line + "; column: " + this.parser.column + ")";
            }
            throw error;
        }
    }
}
