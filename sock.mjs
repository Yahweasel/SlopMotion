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

// Start by getting our WebSocket connection to the server
const sock = new WebSocket("/ws");

export function send(msg) {
    sock.send(msg);
}

let recvd = "";

export const event = new EventTarget();

function recv(msg) {
    recvd += msg;

    const lines = msg.split("\n");

    while (lines.length > 1) {
        try {
            msg = lines.shift();
            msg = JSON.parse(msg);
            event.dispatchEvent(new CustomEvent(msg.c, {
                detail: msg
            }));
        } catch (ex) {
            console.error(ex);
        }
    }

    recvd = lines[0];
}

sock.addEventListener("message", ev => {
    recv(ev.data);
});
await new Promise((res, rej) => {
    sock.addEventListener("open", res);
    sock.addEventListener("error", rej);
});

