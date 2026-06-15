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

// Don't let any guests use Worker
delete globalThis.Worker;

// Don't let any guests use the network (at least, not simply)
const fetch = globalThis.fetch;
delete globalThis.fetch;
delete globalThis.XMLHttpRequest;

// Control speed to make it less painfully fast
const FPS = 24;
const MIN_TIME = 1000/FPS;
const setTimeout = globalThis.setTimeout;
const setInterval = globalThis.setInterval;
const requestAnimationFrame = globalThis.requestAnimationFrame;
globalThis.setTimeout = (func, time) => {
    return setTimeout(func, Math.max(time, MIN_TIME));
};
globalThis.setInterval = (func, time) => {
    return setInterval(func, Math.max(time, MIN_TIME));
};
globalThis.requestAnimationFrame = func => {
    setTimeout(() => {
        requestAnimationFrame(func);
    }, MIN_TIME);
    return 0;
};

// Prevent guests from tampering with the rest
let fortified = new Set();
function fortify(obj) {
    if (fortified.has(obj))
        return;
    fortified.add(obj);
    const keys = Object.getOwnPropertyNames(obj);
    for (const key of keys) {
        try {
            const desc = Object.getOwnPropertyDescriptor(obj, key);
            for (const val of [desc.value, desc.get, desc.set]) {
                if (val !== null && (typeof val === "object" || typeof val === "function"))
                    fortify(val);
            }
            desc.writable = false;
            desc.configurable = false;
            Object.defineProperty(obj, key, desc);
        } catch (ex) {
            continue;
        }
    }
}
fortify(globalThis);

// Wait for the info
let program = "";
let canvas = null;
await new Promise(res => {
    globalThis.addEventListener("message", ev => {
        const msg = ev.data;
        if (typeof msg.program !== "string" || !msg.canvas)
            return;
        program = msg.program;
        canvas = globalThis.canvas = msg.canvas;
        res();
    });
});

function error(message) {
    postMessage({error: true, message});
}

// Prepare for runtime errors
globalThis.addEventListener("error", ev => {
    console.error(ev.message, ev.error);
    error(ev.message);
});
globalThis.addEventListener("unhandledrejection", ev => {
    console.error(ev.reason);
    error(ev.reason + "");
});


// Check for no movement
(async () => {
    await new Promise(res => setTimeout(res, 8000));
    const testCanvas = new OffscreenCanvas(canvas.width, canvas.height);
    const testCtx = testCanvas.getContext("2d");
    testCtx.drawImage(canvas, 0, 0);
    await new Promise(res => setTimeout(res, 8000));
    const dataA = testCtx.getImageData(0, 0, testCanvas.width, testCanvas.height);
    testCtx.clearRect(0, 0, testCanvas.width, testCanvas.height);
    testCtx.drawImage(canvas, 0, 0);
    await new Promise(res => setTimeout(res, 1000));
    const dataB = testCtx.getImageData(0, 0, testCanvas.width, testCanvas.height);

    checker:
    for (let y = 0; y < testCanvas.height; y++) {
        let py = y * testCanvas.width * 4;
        for (let x = 0; x < testCanvas.width; x++) {
            let px = py + x*4;
            if (dataA.data[px + 3] <= 0x10 || dataB.data[px + 3] <= 0x10)
                continue;
            for (let c = 0; c < 3; c++) {
                if (Math.abs(dataA.data[px + c] - dataB.data[px + c]) > 0x10)
                    return;
            }
        }
    }

    error("No action");
})();

// Run it
try {
    await import(`data:application/javascript,${encodeURIComponent(program)}`);
} catch (ex) {
    console.error(ex);
    error(ex.message);
}
