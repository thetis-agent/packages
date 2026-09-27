/* The page's view of Thetis coming and going: whether the connection is up, the one wait for it to go away
 * and come back (`awaitReturn`), and whether any of the person's turns is running. These are the helpers
 * behind `ext.awaitReturn` and `ext.turns`; the tool-operator chip, the control panel's restart and the
 * update notices all wait through the same one, so they all say the same thing at the same moment.
 *
 * "Back" means the event stream opened again after it had dropped: the gateway answered, which means the
 * fence it lives in is up, which means Thetis is. The connection state lives in the store (`connection`:
 * connecting | online | reconnecting), set by the reconnect loop in api.js. */

import { store } from "./store.js";

let hurry = () => {};
let down = false;
let lastReturn = 0;

store.watch("connection", (state) => {
  if (state === "online") {
    if (down) lastReturn = Date.now();
    down = false;
  } else if (state === "reconnecting") down = true;
});

/** Hands over the reconnect loop's `hurry`, so a wait for Thetis to come back retries every two seconds. */
export function bindConnection(handle) {
  hurry = (on) => handle?.hurry?.(on);
}

/** When the connection last came back after a drop, in epoch milliseconds; 0 when it never has. */
export function lastReturnAt() {
  return lastReturn;
}

/**
 * Waits for the connection to go away and come back, or only to come back when it is away already.
 * Answers "back" or, after `timeoutMs`, "timeout". `onState(state)` hears "waiting" (up, waiting for it to
 * go), "gone" (it went) and then "back" or "timeout". `since` (epoch ms) is for a caller that asked for a
 * restart and may have missed it: when the connection already came back after that moment, the answer is
 * "back" at once rather than a wait for a drop that has already happened.
 */
export function awaitReturn({ timeoutMs = 90_000, onState, since } = {}) {
  const say = (state) => {
    try {
      onState?.(state);
    } catch (err) {
      console.error("an awaitReturn onState threw:", err);
    }
  };
  if (typeof since === "number" && lastReturn > since && store.get("connection") === "online") {
    say("back");
    return Promise.resolve("back");
  }
  return new Promise((resolve) => {
    // Away means dropped after it had been up. The page's first connect ("connecting") is not a return.
    let gone = store.get("connection") === "reconnecting";
    let hurried = false;
    let settled = false;
    const speedUp = () => {
      if (hurried) return;
      hurried = true;
      hurry(true);
    };
    const finish = (how) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unwatch();
      if (hurried) hurry(false);
      say(how);
      resolve(how);
    };
    const unwatch = store.watch("connection", (state) => {
      if (state === "online") {
        if (gone) finish("back");
      } else if (state === "reconnecting" && !gone) {
        gone = true;
        speedUp();
        say("gone");
      }
    });
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    say(gone ? "gone" : "waiting");
    if (gone) speedUp();
  });
}

/** Whether any turn of this person is running, subagents included. */
export function turnsRunning() {
  return store.get("running").size > 0;
}

/** Calls `fn()` each time the running set becomes empty. Answers the function that stops it. */
export function onTurnsIdle(fn) {
  let was = turnsRunning();
  return store.watch("running", (running) => {
    const now = running.size > 0;
    if (was && !now) {
      try {
        fn();
      } catch (err) {
        console.error("a turns.onIdle listener threw:", err);
      }
    }
    was = now;
  });
}
