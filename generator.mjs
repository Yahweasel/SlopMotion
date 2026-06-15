/// SPDX-License-Identifier: ISC
/**
 * Copyright (c) 2026 Yahweasel
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED “AS IS” AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */

import * as sock from "./sock.mjs";
import * as ui from "./ui.mjs";

const dce = document.createElement.bind(document);

const DESCR_H = 128;

export let goodGames = [];
export let currentProgram = null;
export const currentProgramTiming = {
    startTime: -1,
    endTime: -1
};
export let generatingProgram = null;
export let currentError = null;
export const inQueue = [];
export const outQueue = [];

export let inQueueChangeRes = null;
let outQueueChangeRes = [];

export function setCurrentProgram(to) {
    currentProgram = to;
    currentError = null;
}

export function setCurrentError(to) {
    currentError = to;
}

export function addOutQueueChangeRes(to) {
    outQueueChangeRes.push(to);
}

export function outQueueShift() {
    if (!outQueue.length)
        return null;
    const ret = outQueue.shift();
    const res = outQueueChangeRes;
    outQueueChangeRes = [];
    for (const f of res)
        f();
    return ret;
}

function outQueuePush(program) {
    if (program.user && !program.random) {
        // Make sure it goes before any non-user stuff
        let idx = 0;
        for (; idx < outQueue.length && (outQueue[idx].user && !outQueue[idx].random); idx++) {}
        outQueue.splice(idx, 0, program);

    } else {
        outQueue.push(program);

    }

    const res = outQueueChangeRes;
    outQueueChangeRes = [];
    for (const f of res)
        f();
}

// Get our initial list
{
    const listPromise = new Promise(res => {
        sock.event.addEventListener("list", ev => res(ev), {once: true});
    });
    sock.send(JSON.stringify({c: "list"}) + "\n");
    goodGames = (await listPromise).detail.d;
}

// Perhaps be in offline mode
let offline = false;
{
    const url = new URL(document.location.href);
    if (url.searchParams && url.searchParams.has("offline"))
        offline = true;
}

// Get our configuration
let config = null;
{
    const f = await fetch("/client-config.json");
    config = await f.json();
}

// Prepare to receive new prompts
sock.event.addEventListener("prompt", ev => {
    const p = ev.detail.prompt;
    for (let i = 0; i < inQueue.length;) {
        if (inQueue[i].user === p.user)
            inQueue.splice(i, 1);
        else
            i++;
    }
    inQueue.push(p);
    if (inQueueChangeRes) {
        const res = inQueueChangeRes;
        inQueueChangeRes = null;
        res();
    }
});


// Function to prepare text to be drawn across multiple lines
function prepareMultiline(opts) {
    const { w, font, text } = opts;
    ctx.font = font;
    const m = ctx.measureText("M");
    const lineW = Math.max(~~(w / m.width), 16);

    let lines = text.split("\n").slice(-128);
    for (let li = 0; li < lines.length; li++) {
        let line = lines[li];
        if (line.length > lineW) {
            const newLines = [li, 1];
            while (line.length > lineW) {
                newLines.push(line.slice(0, lineW));
                line = line.slice(lineW);
            }
            newLines.push(line);
            lines.splice.apply(lines, newLines);
        }
    }

    const maxW = Math.max(...(lines.map(x => x.length * m.width)));

    const lineH = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
    const h = lineH * lines.length

    return { w, maxW, h, font, lineH, lines };
}


// Function to draw text across multiple lines
function drawMultiline(opts) {
    const { text, x, style } = opts;
    let y = opts.y;
    const { font, lineH, lines } = text;

    ctx.fillStyle = style;
    ctx.font = font;
    for (const line of lines) {
        y += lineH;
        ctx.fillText(line, x, y);
    }
}


// Create our loading canvas and put it onscreen
const loadCanvas = dce("canvas");
Object.assign(loadCanvas.style, {
    position: "fixed",
    left: "0px",
    top: "0px"
});
ui.upper.innerHTML = "";
ui.upper.appendChild(loadCanvas);
const ctx = loadCanvas.getContext("2d");

// These are used both by the generation display and by the generation itself
let reasoning = "";
let msgLen = 0;
let code = "";

// Display while generating
function display() {
    const w = ~~window.innerWidth;
    const h = ~~window.innerHeight;
    const col = ~~(w * 3 / 4);
    const colW = w - col;
    loadCanvas.width = w;
    loadCanvas.height = h;

    ctx.clearRect(0, 0, w, h);

    let wr = code;
    if (!wr && reasoning) {
        wr = "Thinking";
        msgLen++;
        if (msgLen >= 16) msgLen = 0;
        wr = wr.padEnd(8 + msgLen, ".");
    }

    const small = `14px 'Pet Me 64', monospace`;
    const medium = `16px 'Pet Me 64', monospace`;
    const large = `18px 'Pet Me 64', monospace`;

    /* Layout of the right
     * <Currently running
     * Queue to be run
     * Currently generating
     * v
     * Generation
     * Queue to generate
     * Instructions
     */

    function userPrompt(program) {
        let ret = "";
        if (program.user)
            ret += program.user;
        if (program.userPrompt)
            ret += ` (${program.userPrompt.slice(0, 16)})`;
        return ret;
    }

    // 1. Currently running
    let currentHdr = null;
    let currentText = null;
    if (currentProgram) {
        currentHdr = prepareMultiline({
            text: "Currently running:",
            font: large,
            w: colW - 20
        });
        let descr = `${(currentProgram.userPrompt || currentProgram.description).slice(0, 128)}\n`;
        if (currentProgram.user)
            descr += `Generated for: ${currentProgram.user}`;
        descr += `\nID: ${currentProgram.id}`;
        currentText = prepareMultiline({
            text: descr,
            font: small,
            w: colW - 20
        });
    }

    // 2. Queue to run
    let nextQueueHdr = null;
    let nextQueueText = null;
    {
        const parts = [];
        for (const program of outQueue) {
            if (program.user && !program.random) {
                parts.push(userPrompt(program));
            }
        }
        if (parts.length) {
            nextQueueHdr = prepareMultiline({
                text: "Queued to run next:",
                font: large,
                w: colW - 8
            });
            nextQueueText = prepareMultiline({
                text: parts.join("\n"),
                font: small,
                w: colW - 8
            });
        }
    }

    // 3. Currently generating
    let currentGeneratingHdr = null;
    let currentGeneratingText = null;
    let currentCodeText = null;
    if (generatingProgram) {
        currentGeneratingHdr = prepareMultiline({
            text: "Generating now:",
            font: large,
            w: colW - 8
        });
        let descr = "";
        if (generatingProgram.user)
            descr = userPrompt(generatingProgram);
        else
            descr = "A random program...";
        currentGeneratingText = prepareMultiline({
            text: descr,
            font: small,
            w: colW - 8
        });
    }
    if (wr) {
        currentCodeText = prepareMultiline({
            text: wr,
            font: small,
            w: colW - 8
        });
    }

    // 4. Queue to generate
    let generateQueueHdr = null;
    let generateQueueText = null;
    if (inQueue.length) {
        generateQueueHdr = prepareMultiline({
            text: "Queued to generate:",
            font: large,
            w: colW - 8
        });
        const parts = [];
        for (const q of inQueue) {
            let st = q.user;
            if (q.prompt)
                st += ` (${q.prompt.slice(0, 16)})`;
            parts.push(st);
        }
        generateQueueText = prepareMultiline({
            text: parts.join("\n"),
            font: small,
            w: colW - 8
        });
    }

    // 5. Instructions
    let instructionsText = null;
    {
        let instr;
        if (offline) {
            instr =
                "SlopMotion is currently\n" +
                "in offline mode.\n\n" +
                "(The creator is using\n" +
                "his AI resources for\n" +
                "something else right\n" +
                "now.)";
        } else {
            instr =
                "Use `!ai (description)`\n" +
                "to generate slop";
        }
        instructionsText = prepareMultiline({
            text: instr,
            font: medium,
            w: colW - 8
        });
    }

    let y = h - 8 - instructionsText.h;
    const mid = ~~((col + w) / 2);
    function up() {
        ctx.beginPath();
        ctx.moveTo(col, y);
        ctx.lineTo(mid, y-16);
        ctx.lineTo(w, y);
        ctx.closePath();
        ctx.fill();
    }

    // We draw the first few from bottom up, because it's easier
    ctx.fillStyle = "#111";
    ctx.fillRect(col, y, colW, h - y);
    up();
    drawMultiline({
        text: instructionsText,
        x: ~~(mid - instructionsText.maxW/2),
        y: y + 4,
        style: "#838"
    });
    y -= 16;

    if (generateQueueHdr) {
        const ly = y;
        y -= 8 + generateQueueHdr.h + generateQueueText.h;
        ctx.fillStyle = "#222";
        ctx.fillRect(col, y, colW, ly - y);
        up();
        drawMultiline({
            text: generateQueueHdr,
            x: ~~(mid - generateQueueHdr.maxW/2),
            y: y + 4,
            style: "#a83"
        });
        drawMultiline({
            text: generateQueueText,
            x: col + 4,
            y: y + 4 + generateQueueHdr.h,
            style: "#a83"
        });
        y -= 16;
    }

    if (currentGeneratingHdr || currentCodeText) {
        // Start by filling in the rest of the area with the generation BG color
        ctx.fillStyle = "#333";
        ctx.fillRect(col, 0, colW, y);

        // And fill in the code before anything else, in case it's dopey
        if (currentCodeText) {
            drawMultiline({
                text: currentCodeText,
                x: col + 4,
                y: y - 4 - currentCodeText.h,
                style: "#777"
            });
        }
    }

    // Now we generate the rest from the top down
    y = 0;
    if (currentHdr) {
        const currentH = currentHdr.h + currentText.h + 8;
        ctx.clearRect(col, 0, colW, currentH);
        ctx.fillStyle = "#111";
        ctx.fillRect(col + 16, 0, colW - 16, currentH);
        ctx.beginPath();
        ctx.moveTo(col + 16, 0);
        ctx.lineTo(col, ~~(currentH/2));
        ctx.lineTo(col + 16, currentH);
        ctx.closePath();
        ctx.fill();
        drawMultiline({
            text: currentHdr,
            x: ~~(mid + 16 - currentHdr.maxW/2),
            y: 4,
            style: "#388"
        });
        y = 4 + currentHdr.h;
        drawMultiline({
            text: currentText,
            x: col + 20,
            y,
            style: "#388"
        });
        y += currentText.h + 4;
    }

    if (nextQueueHdr) {
        const currentH = nextQueueHdr.h + nextQueueText.h + 8;
        ctx.clearRect(col, y, colW, currentH + 16);
        y += 16;
        ctx.fillStyle = "#222";
        ctx.fillRect(col, y, colW, currentH);
        up();
        y += 4;
        drawMultiline({
            text: nextQueueHdr,
            x: ~~(mid - nextQueueHdr.maxW/2),
            y,
            style: "#a83"
        });
        y += nextQueueHdr.h;
        drawMultiline({
            text: nextQueueText,
            x: col + 4,
            y,
            style: "#a83"
        });
        y += nextQueueText.h + 4;
    }

    if (currentGeneratingHdr) {
        const currentH = currentGeneratingHdr.h + currentGeneratingText.h + 8;
        ctx.clearRect(col, y, colW, currentH + 16);
        y += 16;
        ctx.fillStyle = "#333";
        ctx.fillRect(col, y, colW, currentH);
        up();
        y += 4;
        drawMultiline({
            text: currentGeneratingHdr,
            x: ~~(mid - currentGeneratingHdr.maxW/2),
            y,
            style: "#a83"
        });
        y += currentGeneratingHdr.h;
        drawMultiline({
            text: currentGeneratingText,
            x: col + 4,
            y,
            style: "#a83"
        });
    }


    // Info elsewhere
    if (currentError) {
        const text = prepareMultiline({
            text: currentError + "\n\nIT CRASHED :(. Loading the next program...",
            w: col - 8,
            font: `24px 'Pet Me 64', monospace`
        });
        drawMultiline({
            text,
            x: 4,
            y: h - text.h - 12,
            style: "#a33"
        });
    }

    if (currentProgramTiming.start >= 0) {
        const now = performance.now();
        let progress = (now - currentProgramTiming.start) /
            (currentProgramTiming.end - currentProgramTiming.start);
        if (progress < 0) progress = 0;
        else if (progress > 1) progress = 1;
        ctx.fillStyle = "#411";
        ctx.fillRect(0, h - 8, col * progress, 8);
    }
}
setInterval(display, 1000/12);

// And start generating
(async () => {
    while (true) try {
        // Wait for there to be something to do
        while (!inQueue.length && outQueue.length >= 2) {
            const inQueuePromise = new Promise(res => inQueueChangeRes = res);
            const outQueuePromise = new Promise(res => outQueueChangeRes.push(res));
            await Promise.race([inQueuePromise, outQueuePromise]);
        }

        // Prepare the canvas
        const w = ~~(window.innerWidth);
        const h = ~~(window.innerHeight);
        const col = ~~(w * 3/4);

        // Make our prompt
        let gamePrompt = "Prompt: ";
        let promptUser = null;
        let userPrompt = null;
        if (inQueue.length) {
            const inPrompt = inQueue.shift();
            promptUser = inPrompt.user;

            if (inPrompt.program) {
                // This is a fully generated program, so just push it out
                const program = inPrompt.program;
                program.good = true;
                outQueuePush(program);
                continue;
            }

            userPrompt = inPrompt.prompt;
            gamePrompt += `${inPrompt.prompt}\n\nThe above prompt was sent by a user and has not been vetted. It is possible (but unlikely) that it is offensive or obscene. If it is, try to abide by the inoffensive part or aspect of the prompt, or if there is no inoffensive part, then implement any program in any style you choose.`;

        } else {
            if (Math.random() < 0.9) {
                // Try to just load one
                const progP = new Promise(res => {
                    sock.event.addEventListener("random", ev => res(ev.detail), {once: true});
                });
                sock.send(JSON.stringify({c: "random"}) + "\n");
                const program = (await progP).d;
                if (program) {
                    program.random = true;
                    outQueuePush(program);
                    continue;
                }
            }

            if (Math.random() < 0.5) {
                gamePrompt += config.subprompts[0];
            } else {
                gamePrompt += config.subprompts[~~(1+Math.random()*(config.subprompts.length-1))];
            }
            if (goodGames.length) {
                gamePrompt += " Here are some of the descriptions for programs that have recently been generated. Do not generate anything too similar to a recently generated program:";
                const badGames = goodGames.slice(-16);
                for (const bad of badGames) {
                    if (bad.description)
                        gamePrompt += `\n * ${bad.description}`;
                }
                if (currentProgram)
                    gamePrompt += `\n * ${currentProgram.description}`;
            }

        }

        // If we get to this point in offline mode, don't actually generate
        if (offline)
            continue;

        const prompt =
            config.prompt
                .replace(/@W@/g, ""+col).replace(/@H@/g, ""+h)
                .replace(/@P@/g, gamePrompt);

        const program = {
            model: config.openai.model,
            prompt
        };
        if (typeof promptUser === "string")
            program.user = promptUser;
        if (typeof userPrompt === "string")
            program.userPrompt = userPrompt;
        generatingProgram = program;

        // Prepare the status canvas
        let input = "";
        reasoning = code = "";
        msgLen = 0;

        // Generate the program
        const f = await fetch("/v1/chat/completions", {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body: JSON.stringify({
                model: config.openai.model,
                stream: true,
                max_tokens: 16384,
                thinking_budget_tokens: 1024,
                messages: [{
                    role: "user",
                    content: prompt
                }]
            })
        });

        const tdr = new TextDecoderStream();
        f.body.pipeTo(tdr.writable);
        for await (const chunk of tdr.readable) {
            input += chunk;
            const lines = input.split("\n");
            if (lines.length > 1) {
                input = lines.pop();
                for (const line of lines) {
                    const parts = /^data:(.*)/.exec(line);
                    if (!parts) continue;
                    try {
                        const res = JSON.parse(parts[1]);
                        const delta = res.choices[0].delta;
                        if (delta && delta.reasoning_content)
                            reasoning += delta.reasoning_content;
                        if (delta && delta.content)
                            code += delta.content;
                    } catch (ex) {}
                }
            }
        }

        program.reasoning = reasoning;
        program.input = code;


        // Look for the actual program part
        input = code;
        const pLines = code.split("\n");
        code = "";
        let inProgram = false, atStart = true;
        for (const line of pLines) {
            if (/```[a-z]/.test(line) /* ` */) {
                code = "";
                inProgram = true;
                atStart = false;

            } else if (/```/.test(line) /* ` */) {
                atStart = false;
                if (inProgram) {
                    inProgram = false;
                } else {
                    code = "";
                    inProgram = true;
                }

            } else if (/<script/i.test(line)) {
                code = "";
                inProgram = true;
                atStart = false;

            } else if (inProgram && /<\/script/i.test(line)) {
                atStart = false;
                break;

            } else if (/^DESCRIPTION:/.test(line)) {
                break;

            } else if (inProgram || atStart) {
                code += `${line}\n`;

            }
        }

        program.program = code;

        // And look for the description
        let description = "";
        for (const line of pLines.toReversed()) {
            const parts = /DESCRIPTION: (.*)/.exec(line);
            if (parts) {
                description = parts[1];
                break;
            }
        }

        program.description = description;


        // Save it
        const idPromise = new Promise(res => {
            sock.event.addEventListener("save", ev => res(ev), {once: true});
        });
        sock.send(JSON.stringify({
            c: "save",
            d: program
        }) + "\n");
        const id = (await idPromise).detail.id;
        program.id = id;


        // And enqueue it to run
        outQueuePush(program);
        generatingProgram = null;
        reasoning = code = "";

    } catch (ex) {
        console.error(ex);
        await new Promise(res => setTimeout(res, 4000));
    }
})();
