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

import * as generator from "./generator.mjs";
import * as sock from "./sock.mjs";
import * as ui from "./ui.mjs";

const dce = document.createElement.bind(document);

// Handle switching current game/canvas
let currentCanvas = null;
let currentWorker = null;
let currentTimeout = null;
function loadGame(opts) {
    const {
        program, w, h, timeout
    } = opts;

    if (currentWorker)
        currentWorker.terminate();

    const playCanvas = dce("canvas");
    Object.assign(playCanvas.style, {
        position: "fixed",
        left: "0px",
        top: "0px"
    });
    playCanvas.width = w;
    playCanvas.height = h;

    const worker = new Worker("worker.mjs", {type: "module"});
    ui.lower.innerHTML = "";
    ui.lower.appendChild(playCanvas);
    currentCanvas = playCanvas;
    const osCanvas = playCanvas.transferControlToOffscreen();
    worker.postMessage({
        program: program.program,
        canvas: osCanvas
    }, [osCanvas]);
    currentWorker = worker;

    let end;
    if (timeout > 0) {
        const now = performance.now();
        generator.currentProgramTiming.start = now;
        generator.currentProgramTiming.end = now + timeout;
        end = new Promise(res => setTimeout(() => res(false), timeout));
    } else {
        generator.currentProgramTiming.start = -1;
        generator.currentProgramTiming.end = -1;
        end = new Promise(res => {
            generator.addOutQueueChangeRes(() => res(false));
        });
        if (timeout < 0) {
            const end2 = new Promise(res => setTimeout(() => res(false), -timeout));
            end = Promise.race([end, end2]);
        }
    }
    const error = new Promise(res => {
        worker.addEventListener("error", ev => res(ev.message));
        worker.addEventListener("message", ev => res(ev.data.message));
    }).then(async err => {
        generator.setCurrentError(err);
        await new Promise(res => setTimeout(res, 10000));
        return true;
    });

    currentTimeout = Promise.race([end, error]).then(err => {
        if (!program.good && !err) {
            program.good = true;
            generator.goodGames.push(program);
            sock.send(JSON.stringify({
                c: "good",
                id: program.id
            }) + "\n");
        }
        return err;
    });
    generator.setCurrentProgram(program);
}

(async () => {
    while (true) {
        if (currentTimeout)
            await currentTimeout;

        // Get a program to run
        let program = generator.outQueueShift();
        let timeout = 2*60*1000;
        if (!program) {
            timeout = -timeout;
            if (generator.goodGames.length) {
                const idx = ~~(Math.random() * generator.goodGames.length);
                program = generator.goodGames[idx];
            }
        }

        if (!program) {
            await new Promise(res => generator.addOutQueueChangeRes(res));
            continue;
        }

        const w = ~~(window.innerWidth * 3 / 4);
        const h = ~~window.innerHeight;

        // Load the new program
        loadGame({program, w, h, timeout});
    }
})();
