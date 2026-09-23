`@xterm/xterm` 6.0.0, MIT. The licence is beside this file.

`lib/xterm.mjs` is vendored here as `xterm.js`: the gateway serves `.js`, `.css`, `.svg`, `.json` and
`.md` only, and the file is an ES module whatever it is called. `css/xterm.css` is vendored unchanged and
pulled in by `../index.css`.

One patch is applied to `xterm.js`, and nothing else in it is edited. The library writes its own
stylesheet at runtime — about 55 KiB of palette, font metrics and cursor rules, generated for each
terminal from the theme — and the gateway's content security policy refuses inline CSS. The gateway
therefore mints a nonce for each page and carries it in `<meta name="csp-nonce">`; the patch stamps that
nonce on the three style elements the library creates, so those stylesheets are allowed and every other
inline stylesheet is still refused. See `src/sandbox/README.md`.

The patch is a helper at the head of the file and three call sites:

```sh
npm pack @xterm/xterm@<version>            # then, from the unpacked package/
cp lib/xterm.mjs    <here>/xterm.js
cp css/xterm.css    <here>/xterm.css
cp LICENSE          <here>/LICENSE
# then re-apply the patch: prepend the __thetisNonce helper and wrap each
# `<something>.createElement("style")` in it, minding that the object before the dot stays put.
grep -o '__thetisNonce(' xterm.js | wc -l   # must print 3
node --check xterm.js
```
