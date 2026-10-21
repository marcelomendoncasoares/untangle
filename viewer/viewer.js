// The review page: the chain map first, then chains, then code. It renders the model built by
// the analysis (git + tree-sitter + the Dart language server) and keeps your review marks: on the
// untangle server that serves it, or in this browser for a page saved on its own.
(function () {
  'use strict';
  const C = window.ReviewCore;
  const { nList, agentLabel } = C;
  const $ = (sel, el) => (el || document).querySelector(sel);
  // served: the server keeps marks and answers on demand. key: this review, for browser storage.
  const CONFIG = JSON.parse(($('#d-config') || { textContent: '{}' }).textContent || '{}');
  const MODEL = JSON.parse($('#d-model').textContent);
  const DEFS_ALL = JSON.parse($('#d-defs').textContent);
  const TEST_FILE = /(^|\/)(test|test_[a-z0-9_]+|integration_test)\/|_test\.dart$/;
  const defsNow = () => { if (DEFS_ALL.targets) return DEFS_ALL; const d = DEFS_ALL[state.compare]; return typeof d === 'string' ? DEFS_ALL[d] : d; };
  const REFS = JSON.parse($('#d-refs').textContent);
  const DEFS_OLD = JSON.parse($('#d-defs-old').textContent);
  // The commits (newest first) and which wrote each changed line; null when git couldn't tell.
  const HISTORY = JSON.parse(($('#d-history') || { textContent: 'null' }).textContent || 'null');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const fileName = (p) => p.slice(p.lastIndexOf('/') + 1);
  const wbr = (s) => esc(s).replace(/([.(])/g, '<wbr>$1');
  const fmt = (n) => n.toLocaleString('en-US');
  // Icons: VS Code's Codicons (https://github.com/microsoft/vscode-codicons), CC BY 4.0.
  const svg = (paths) => `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${paths}</svg>`;
  const path1 = (d) => svg(`<path fill-rule="evenodd" clip-rule="evenodd" d="${d}"/>`);
  const ICON = {
    goToFile: path1('M6 5.914l2.06-2.06v-.708L5.915 1l-.707.707.043.043.25.25 1 1h-3a2.5 2.5 0 0 0 0 5H4V7h-.5a1.5 1.5 0 1 1 0-3h3L5.207 5.293 5.914 6 6 5.914zM11 2H8.328l-1-1H12l.71.29 3 3L16 5v9l-1 1H6l-1-1V6.5l1 .847V14h9V6h-4V2zm1 0v3h3l-3-3z'),
    up: path1('M13.854 7l-5-5h-.707l-5 5 .707.707L8 3.561V14h1V3.56l4.146 4.147.708-.707z'),
    back: path1('M7 3.093l-5 5V8.8l5 5 .707-.707-4.146-4.147H14v-1H3.56L7.708 3.8 7 3.093z'),
    // Into the file: drawn with 1.5-pixel strokes, which stay whole at any zoom (Go to File's thin
    // loop breaks up below 100%).
    intoFile: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.75 2.25h4l3 3v7.25a1.25 1.25 0 0 1-1.25 1.25h-5.75"/><path d="M9.75 2.25v3h3"/><path d="M2 9.25h5.5"/><path d="M5.25 7l2.25 2.25-2.25 2.25"/></svg>',
    // The whole file: lines unfolding from a fold, drawn with strokes too.
    wholeFile: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.75v4M5.75 4L8 1.75 10.25 4M8 14.25v-4M5.75 12L8 14.25 10.25 12M2 8h1.5M5.5 8h1.5M9 8h1.5M12.5 8h1.5"/></svg>',
    down: path1('M3.147 9l5 5h.707l5-5-.707-.707L9 12.439V2H8v10.44L3.854 8.292 3.147 9z'),
    tests: svg('<path d="M6 1h4v1h-.5v4.17l3.83 6.7A1.5 1.5 0 0 1 12.03 15H3.97a1.5 1.5 0 0 1-1.3-2.13L6.5 6.17V2H6V1zm1.5 1v4.43l-.07.25L5.37 10.3h5.26L8.57 6.68 8.5 6.43V2h-1zM4.8 11.3l-1.25 2.19a.5.5 0 0 0 .43.51h8.05a.5.5 0 0 0 .43-.75L11.2 11.3H4.8z"/>'),
    map: svg('<path d="M2.5 5.77705V12.0978L5.5 10.2228V3.90205L2.5 5.77705ZM6.5 3.90205V10.2228L9.5 12.0978V5.77705L6.5 3.90205ZM6 11.0896L2.265 13.4239L1.5 12.9999V5.49993L1.735 5.07593L5.735 2.57593H6.265L10 4.9103L13.735 2.57593L14.5 2.99993V10.4999L14.265 10.9239L10.265 13.4239H9.735L6 11.0896ZM10.5 5.77705V12.0978L13.5 10.2228V3.90205L10.5 5.77705Z"/>'),
    mapFilled: svg('<path d="M2 5.5V13L5.5 10.8125V3.3125L2 5.5Z"/><path d="M9.5 12.6875V5.1875L6.5 3.3125V10.8125L9.5 12.6875Z"/><path d="M10.5 12.6875V5.1875L14 3V10.5L10.5 12.6875Z"/>'),
    split: svg('<path d="M14 1H3L2 2v11l1 1h11l1-1V2l-1-1zM8 13H3V2h5v11zm6 0H9V2h5v11z"/>'),
    foldUp: svg('<path d="M1 7.4l.7.7 6-6 6 6 .7-.7L8.1 1h-.7L1 7.4zm0 6l.7.7 6-6 6 6 .7-.7L8.1 7h-.7L1 13.4z"/>'),
    foldDown: path1('M14.207 1.707L13.5 1l-6 6-6-6-.707.707 6.353 6.354h.708l6.353-6.354zm0 6L13.5 7l-6 6-6-6-.707.707 6.353 6.354h.708l6.353-6.354z'),
    unfold: path1('M7.53 6.51v-4l-1 1-.71-.71L7.65 1h.71l1.84 1.83-.71.7-1-1v3.98h-.96zm0 2.98v4l-1-1-.71.71L7.65 15h.71l1.84-1.83-.71-.7-1 1V9.49h-.96zM13.73 4L14 5.02l-3.68 2.93L14 10.98 13.73 12h-4.2v-1h3L9.55 8.57H6.54L3.45 11h3.08v1H2.27L2 10.98l3.68-2.92L2 5.02 2.27 4h4.26v1H3.45l3 2.42h3.01L12.53 5h-3V4h4.2z'),
    chevronRight: path1('M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z'),
    chevronDown: path1('M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z'),
    comment: svg('<path d="M14.5 2h-13l-.5.5v9l.5.5H4v2.5l.854.354L7.707 12H14.5l.5-.5v-9l-.5-.5zm-.5 9H7.5l-.354.146L5 13.293V11.5l-.5-.5H2V3h12v8z"/>'),
    discussion: path1('M4 11.29l1-1v1.42l-1.15 1.14L3 12.5V10H1.5L1 9.5v-8l.5-.5h12l.5.5V6h-1V2H2v7h1.5l.5.5v1.79zM10.29 13l1.86 1.85.85-.35V13h1.5l.5-.5v-5l-.5-.5h-8l-.5.5v5l.5.5h3.79zm.21-1H7V8h7v4h-1.5l-.5.5v.79l-1.15-1.14-.35-.15z'),
    edit: svg('<path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l8-8 1.77 1.77-8 8z"/>'),
    copy: svg('<path fill-rule="evenodd" clip-rule="evenodd" d="M4 4l1-1h5.414L14 6.586V14l-1 1H5l-1-1V4zm9 3l-3-3H5v10h8V7z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M3 1L2 2v10l1 1V2h6.414l-1-1H3z"/>'),
    trash: path1('M10 3h3v1h-1v9l-1 1H4l-1-1V4H2V3h3V2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zM9 2H6v1h3V2zM4 13h7V4H4v9zm2-8H5v7h1V5zm1 0h1v7H7V5zm2 0h1v7H9V5z'),
    smiley: path1('M4.111 2.18a7 7 0 1 1 7.778 11.64A7 7 0 0 1 4.11 2.18zm.556 10.809a6 6 0 1 0 6.666-9.978 6 6 0 0 0-6.666 9.978zM6.5 7a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm5 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM8 11a3 3 0 0 1-2.65-1.58l-.87.48a4 4 0 0 0 7.12-.16l-.9-.43A3 3 0 0 1 8 11z'),
    external: svg('<path d="M1.5 1H6v1H2v12h12v-4h1v4.5l-.5.5h-13l-.5-.5v-13l.5-.5z"/><path d="M15 1.5V8h-1V2.707L7.243 9.465l-.707-.708L13.293 2H8V1h6.5l.5.5z"/>'),
    refresh: path1('M4.681 3H2V2h3.5l.5.5V6H5V4a5 5 0 1 0 4.53-.761l.302-.954A6 6 0 1 1 4.681 3z'),
    suggest: path1('M2 3.5l.5-.5h5l.5.5v9l-.5.5h-5l-.5-.5v-9zM3 12h4V6H3v6zm0-7h4V4H3v1zm6.5-2h5l.5.5v9l-.5.5h-5l-.5-.5v-9l.5-.5zm.5 9h4v-2h-4v2zm0-4h4V4h-4v4z'),
    check: path1('M14.431 3.323l-8.47 10-.79-.036-3.35-4.77.818-.574 2.978 4.24 8.051-9.506.764.646z'),
    issue: svg('<path d="M7.50002 1C6.21445 1 4.95774 1.38123 3.88882 2.09546C2.8199 2.80969 1.98674 3.82485 1.49478 5.01257C1.00281 6.20029 0.874098 7.50719 1.1249 8.76807C1.37571 10.0289 1.99479 11.1872 2.90383 12.0962C3.81287 13.0052 4.97108 13.6243 6.23196 13.8751C7.49283 14.1259 8.79973 13.9972 9.98745 13.5052C11.1752 13.0133 12.1903 12.1801 12.9046 11.1112C13.6188 10.0423 14 8.78558 14 7.5C14 5.77609 13.3152 4.1228 12.0962 2.90381C10.8772 1.68482 9.22393 1 7.50002 1ZM7.50002 13C6.41223 13 5.34883 12.6775 4.44436 12.0731C3.53989 11.4688 2.83501 10.6097 2.41873 9.60474C2.00244 8.59974 1.89352 7.4939 2.10574 6.427C2.31796 5.36011 2.8418 4.38015 3.61099 3.61096C4.38018 2.84177 5.36013 2.31793 6.42703 2.10571C7.49392 1.89349 8.59977 2.00242 9.60476 2.4187C10.6098 2.83498 11.4688 3.53987 12.0731 4.44434C12.6775 5.34881 13 6.4122 13 7.5C13 8.95869 12.4205 10.3576 11.3891 11.389C10.3576 12.4205 8.95871 13 7.50002 13Z"/><circle cx="7.50002" cy="7.5" r="1"/>'),
    pr: svg('<path fill-rule="evenodd" clip-rule="evenodd" d="M5.616 4.928a2.487 2.487 0 0 1-1.119.922c-.148.06-.458.138-.458.138v5.008a2.51 2.51 0 0 1 1.579 1.062c.273.412.419.895.419 1.388.008.343-.057.684-.19 1A2.485 2.485 0 0 1 3.5 15.984a2.482 2.482 0 0 1-1.388-.419A2.487 2.487 0 0 1 1.05 13c.095-.486.331-.932.68-1.283.349-.343.79-.579 1.269-.68V5.949a2.6 2.6 0 0 1-1.269-.68 2.503 2.503 0 0 1-.68-1.283 2.487 2.487 0 0 1 1.06-2.565A2.49 2.49 0 0 1 3.5 1a2.504 2.504 0 0 1 1.807.729 2.493 2.493 0 0 1 .729 1.81c.002.494-.144.978-.42 1.389zm-.756 7.861a1.5 1.5 0 0 0-.552-.579 1.45 1.45 0 0 0-.77-.21 1.495 1.495 0 0 0-1.47 1.79 1.493 1.493 0 0 0 1.18 1.179c.288.058.586.03.86-.08.276-.117.512-.312.68-.56.15-.226.235-.49.249-.76a1.51 1.51 0 0 0-.177-.78zM2.708 4.741c.247.161.536.25.83.25.271 0 .538-.075.77-.211a1.514 1.514 0 0 0 .729-1.359 1.513 1.513 0 0 0-.25-.76 1.551 1.551 0 0 0-.68-.56 1.49 1.49 0 0 0-.86-.08 1.494 1.494 0 0 0-1.179 1.18c-.058.288-.03.586.08.86.117.276.312.512.56.68zm10.329 6.296c.48.097.922.335 1.269.68.466.47.729 1.107.725 1.766.002.493-.144.977-.42 1.388a2.499 2.499 0 0 1-4.532-.899 2.5 2.5 0 0 1 1.067-2.565c.267-.183.571-.308.889-.37V5.489a1.5 1.5 0 0 0-1.5-1.499H8.687l1.269 1.27-.71.709L7.117 3.84v-.7l2.13-2.13.71.711-1.269 1.27h1.85a2.484 2.484 0 0 1 2.312 1.541c.125.302.189.628.187.957v5.548zm.557 3.509a1.493 1.493 0 0 0 .191-1.89 1.552 1.552 0 0 0-.68-.559 1.49 1.49 0 0 0-.86-.08 1.493 1.493 0 0 0-1.179 1.18 1.49 1.49 0 0 0 .08.86 1.496 1.496 0 0 0 2.448.49z"/>'),
    merged: svg('<path d="M13.273 7.73a2.51 2.51 0 0 0-3.159-.31 2.5 2.5 0 0 0-.921 1.12 2.23 2.23 0 0 0-.13.44 4.52 4.52 0 0 1-4-4 2.23 2.23 0 0 0 .44-.13 2.5 2.5 0 0 0 1.54-2.31 2.45 2.45 0 0 0-.19-1A2.48 2.48 0 0 0 5.503.19a2.45 2.45 0 0 0-1-.19 2.5 2.5 0 0 0-2.31 1.54 2.52 2.52 0 0 0 .54 2.73c.35.343.79.579 1.27.68v5.1a2.411 2.411 0 0 0-.89.37 2.5 2.5 0 1 0 3.47 3.468 2.5 2.5 0 0 0 .42-1.387 2.45 2.45 0 0 0-.19-1 2.48 2.48 0 0 0-1.81-1.49v-2.4a5.52 5.52 0 0 0 2 1.73 5.65 5.65 0 0 0 2.09.6 2.5 2.5 0 0 0 4.95-.49 2.51 2.51 0 0 0-.77-1.72zm-8.2 3.38c.276.117.512.312.68.56a1.5 1.5 0 0 1-2.08 2.08 1.55 1.55 0 0 1-.56-.68 1.49 1.49 0 0 1-.08-.86 1.49 1.49 0 0 1 1.18-1.18 1.49 1.49 0 0 1 .86.08zM4.503 4a1.5 1.5 0 0 1-1.39-.93 1.49 1.49 0 0 1-.08-.86 1.49 1.49 0 0 1 1.18-1.18 1.49 1.49 0 0 1 .86.08A1.5 1.5 0 0 1 4.503 4zm8.06 6.56a1.5 1.5 0 0 1-2.45-.49 1.49 1.49 0 0 1-.08-.86 1.49 1.49 0 0 1 1.18-1.18 1.49 1.49 0 0 1 .86.08 1.499 1.499 0 0 1 .49 2.45z"/>'),
    chevronLeft: path1('M5.928 7.976l4.357 4.357-.618.62L5 8.284v-.618L9.667 3l.618.619-4.357 4.357z'),
    chevronUp: path1('M8.024 5.928l-4.357 4.357-.62-.618L7.716 5h.618L13 9.667l-.619.618-4.357-4.357z'),
    more: svg('<path d="M4 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm5 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm5 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>'),
    graph: svg('<path d="M13.5 11h-1.729L8.438 6H9.5l.5-.5v-4L9.5 1h-4l-.5.5v4l.5.5h1.062l-3.333 5H1.5l-.5.5v3l.5.5h3l.5-.5v-3l-.5-.5h-.068L7.5 6.4l3.068 4.6H10.5l-.5.5v3l.5.5h3l.5-.5v-3l-.5-.5zM6 5V2h3v3H6zm-2 7v2H2v-2h2zm9 2h-2v-2h2v2z"/>'),
    chain: path1('M4.4 3h3.085a3.4 3.4 0 0 1 3.4 3.4v.205A3.4 3.4 0 0 1 7.485 10H7V9h.485A2.4 2.4 0 0 0 9.88 6.61V6.4A2.4 2.4 0 0 0 7.49 4H4.4A2.4 2.4 0 0 0 2 6.4v.205A2.394 2.394 0 0 0 4 8.96v1a3.4 3.4 0 0 1-3-3.35V6.4A3.405 3.405 0 0 1 4.4 3zM12 7.04v-1a3.4 3.4 0 0 1 3 3.36v.205A3.405 3.405 0 0 1 11.605 13h-3.09A3.4 3.4 0 0 1 5.12 9.61V9.4A3.4 3.4 0 0 1 8.515 6H9v1h-.485A2.4 2.4 0 0 0 6.12 9.4v.205A2.4 2.4 0 0 0 8.515 12h3.09A2.4 2.4 0 0 0 14 9.61V9.4a2.394 2.394 0 0 0-2-2.36z'),
    file: path1('M13.71 4.29l-3-3L10 1H4L3 2v12l1 1h9l1-1V5l-.29-.71zM13 14H4V2h5v4h4v8zm-3-9V2l3 3h-3z'),
    symbol: svg('<path d="M13.51 4l-5-3h-1l-5 3-.49.86v6l.49.85 5 3h1l5-3 .49-.85v-6L13.51 4zm-6 9.56l-4.5-2.7V5.7l4.5 2.45v5.41zM3.27 4.7l4.74-2.84 4.74 2.84-4.74 2.59L3.27 4.7zm9.74 6.16l-4.5 2.7V8.15l4.5-2.45v5.16z"/>'),
    symbolClass: svg('<path d="M11.34 9.71h.71l2.67-2.67v-.71L13.38 5h-.7l-1.82 1.81h-5V5.56l1.86-1.85V3l-2-2H5L1 5v.71l2 2h.71l1.14-1.15v5.79l.5.5H10v.52l1.33 1.34h.71l2.67-2.67v-.71L13.37 10h-.7l-1.86 1.85h-5v-4H10v.48l1.34 1.38zm1.69-3.65l.63.63-2 2-.63-.63 2-2zm0 5l.63.63-2 2-.63-.63 2-2zM3.35 6.65l-1.29-1.3 3.29-3.29 1.3 1.29-3.3 3.3z"/>'),
    symbolField: svg('<path d="M14.45 4.5l-5-2.5h-.9l-7 3.5-.55.89v4.5l.55.9 5 2.5h.9l7-3.5.55-.9v-4.5l-.55-.89zm-8 8.64l-4.5-2.25V7.17l4.5 2v3.97zm.5-4.8L2.29 6.23l6.66-3.34 4.67 2.34-6.67 3.11zm7 1.55l-6.5 3.25V9.21l6.5-3v3.68z"/>'),
    symbolVariable: path1('M2 5h2V4H1.5l-.5.5v8l.5.5H4v-1H2V5zm12.5-1H12v1h2v7h-2v1h2.5l.5-.5v-8l-.5-.5zm-2.74 2.57L12 7v2.51l-.3.45-4.5 2h-.46l-2.5-1.5-.24-.43v-2.5l.3-.46 4.5-2h.46l2.5 1.5zM5 9.71l1.5.9V9.28L5 8.38v1.33zm.58-2.15l1.45.87 3.39-1.5-1.45-.87-3.39 1.5zm1.95 3.17l3.5-1.56v-1.4l-3.5 1.55v1.41z'),
    symbolEnum: path1('M14 2H8L7 3v3h1V3h6v5h-4v1h4l1-1V3l-1-1zM9 6h4v1H9.41L9 6.59V6zM7 7H2L1 8v5l1 1h6l1-1V8L8 7H7zm1 6H2V8h6v5zM3 9h4v1H3V9zm0 2h4v1H3v-1zm6-7h4v1H9V4z'),
    symbolInterface: svg('<path d="M11.496 4a3.49 3.49 0 0 0-3.46 3h-3.1a2 2 0 1 0 0 1h3.1a3.5 3.5 0 1 0 3.46-4zm0 6a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/>'),
    search: svg('<circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 11 L15 15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'),
    eye: svg('<path d="M7.99993 6.00316C9.47266 6.00316 10.6666 7.19708 10.6666 8.66981C10.6666 10.1426 9.47266 11.3365 7.99993 11.3365C6.52715 11.3365 5.33324 10.1426 5.33324 8.66981C5.33324 7.19708 6.52715 6.00316 7.99993 6.00316ZM7.99993 7.00315C7.07946 7.00315 6.33324 7.74935 6.33324 8.66981C6.33324 9.59028 7.07946 10.3365 7.99993 10.3365C8.9204 10.3365 9.6666 9.59028 9.6666 8.66981C9.6666 7.74935 8.9204 7.00315 7.99993 7.00315ZM7.99993 3.66675C11.0756 3.66675 13.7307 5.76675 14.4673 8.70968C14.5344 8.97755 14.3716 9.24908 14.1037 9.31615C13.8358 9.38315 13.5643 9.22041 13.4973 8.95248C12.8713 6.45205 10.6141 4.66675 7.99993 4.66675C5.38454 4.66675 3.12664 6.45359 2.50182 8.95555C2.43491 9.22341 2.16348 9.38635 1.89557 9.31948C1.62766 9.25255 1.46471 8.98115 1.53162 8.71321C2.26701 5.76856 4.9229 3.66675 7.99993 3.66675Z"/>'),
    sidebar: path1('M2 1L1 2V14L2 15H14L15 14V2L14 1H2ZM14 14H7V2H14V14Z'),
    minimap: svg('<path d="M2 2h7v1H2zM2 4.5h9v1H2zM2 7h5v1H2zM2 9.5h8v1H2zM2 12h6v1H2z"/><path d="M12 1h3v14h-3z" opacity=".55"/>'),
    close: path1('M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z'),
    listTree: path1('M1 2h12v1H1zM2.5 3h1v6.5h-1zM3.5 5.5H15v1H3.5zM3.5 9H15v1H3.5zM1 12.5h12v1H1z'),
    listFlat: path1('M1 2h14v1H1zM1 5.5h14v1H1zM1 9h14v1H1zM1 12.5h14v1H1z'),
    history: path1('M13.507 12.324a7 7 0 0 0 .065-8.56A7 7 0 0 0 2 4.393V2H1v3.5l.5.5H5V5H2.811a6.008 6.008 0 1 1-.135 5.77l-.887.462a7 7 0 0 0 11.718 1.092zm-3.361-.97l.708-.707L8 7.792V4H7v4l.146.354 3 3z'),
  };
  // An icon button: its tooltip says what a click does; a toggle keeps one name and says whether it's on.
  const iconBtn = (ic, title, attrs, toggle) => `<button type="button" class="ib" ${attrs} title="${esc(title)}" aria-label="${esc(toggle ? toggle.label : title)}"${toggle ? ` aria-pressed="${toggle.on}"` : ''}>${ic}</button>`;

  const viewer = $('#viewer'), side = $('#vw-side'), main = $('#vw-main');
  // A narrow window, a phone's among them: one pane at a time, the sidebar a drawer (Contents).
  const COMPACT = window.matchMedia ? window.matchMedia('(max-width: 960px)') : { matches: false, addEventListener() {} };
  const compact = () => COMPACT.matches;
  // A touch screen: lines are picked from their gutter, with nothing to hover.
  const COARSE = window.matchMedia ? window.matchMedia('(hover: none) and (pointer: coarse)') : { matches: false, addEventListener() {} };
  const PHONE = window.matchMedia ? window.matchMedia('(max-width: 520px)') : { matches: false, addEventListener() {} };
  // Long lines wrap, under their own indent, on a phone (or as ⋯ says, in any narrow window).
  const wrapOn = () => compact() && (UI.wrap != null ? !!UI.wrap : PHONE.matches);
  // A test's details (its expects, the lines it changed, its commit, a way into the file) wait for
  // the pointer; with nothing to hover, they show, unless ⋯ says otherwise.
  const testDetails = () => (UI.testDetails != null ? !!UI.testDetails : COARSE.matches);
  const codeSize = () => UI.codeSize || (PHONE.matches ? 12 : 12.5);
  // Side by side needs the width: a narrow window shows the diff in one column.
  const sideBySide = () => state.layout === 'split' && !compact();
  // A line's indent, for a wrapped line's next rows to start under it (a tab as tab-size's 8).
  const indentOf = (text) => { let i = 0, n = 0; for (; i < text.length && n < 32; i++) { if (text[i] === ' ') n++; else if (text[i] === '\t') n += 8; else break; } return Math.min(n, 32); };
  const indentAttr = (text) => { const n = text ? indentOf(text) : 0; return n ? ` style="--i:${n}"` : ''; };
  // The page's calls to untangle say which review the page shows. A 409 answer means untangle has
  // moved on to newer commits (refreshed from another page): this one offers to reload.
  function api(path, init) {
    init = init || {};
    const headers = Object.assign({}, init.headers, CONFIG.head ? { 'x-untangle-head': CONFIG.head } : {});
    return fetch('api/' + path, Object.assign({}, init, { headers })).then((r) => {
      if (r.status === 409) r.clone().json().then((j) => { if (j.moved) { FRESH.moved = j.moved; renderFresh(); } }).catch(() => {});
      return r;
    });
  }

  // ---------- state
  const state = {
    compare: 'base', tab: 'chains', layout: 'unified', showReviewedDiff: false,
    view: { kind: 'map', family: null }, prevView: null, peek: null, focus: null, lens: null,
    // By commit: the commit whose card (History's details) is open under its chain's header.
    card: null,
    // A change's lines from one commit, reviewed under that commit's lens: "<block>@<sha>".
    cmarks: new Set(),
    rev: {},
    blockDiff: new Set(), moveOpen: new Set(), memberOpen: new Set(), collapsed: new Set(), expanded: new Set(), graphOpen: new Set(), groupAll: new Set(), noteOpen: new Set(),
    // Test outlines: rows opened on their code ("<file>#<call>"), and folds opened (unchanged calls
    // under a group, code under unchanged sentences, changes outside the tests).
    olOpen: new Set(), olUnfold: new Set(), testsFilter: 'all',
    search: { q: '', scope: 'unreviewed' },
    // Files shown whole, lines shown around each section of a diff ({ above, below } by its key),
    // and folders closed in the Files tab.
    whole: new Set(), more: new Map(), closedDirs: new Set(), fileSections: new Set(),
  };
  const STORE = 'untangle:' + (CONFIG.key || 'review');
  try {
    const saved = CONFIG.served ? CONFIG.state : JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved) {
      Object.entries(saved.rev || {}).forEach(([k, v]) => { state.rev[k] = new Set(v); });
      state.cmarks = new Set(saved.cmarks || []);
      state.layout = saved.layout === 'split' ? 'split' : 'unified';
      state.showReviewedDiff = !!saved.showReviewedDiff;
    }
  } catch (e) { /* storage unavailable */ }
  // Marks go to the server (a moment after the last change, or as the page goes away), or else
  // to this browser. Only a save as the page may go away asks the browser to finish it after the
  // page is gone, and only when it fits the 64 KB the browser takes that way: it refuses a bigger
  // one whole, and a big review's marks are more.
  const KEEPALIVE_MAX = 60_000;
  let saveTimer = null, pendingSave = null, retryTimer = null, retryIn = 0, unsavedWhy = '';
  function unsaved(why) {
    unsavedWhy = why;
    viewer.classList.toggle('unsaved', !!why);
    const el = viewer.querySelector('.t-unsaved');
    if (el) el.title = why;
  }
  function flushSave(leaving) {
    if (pendingSave == null) return Promise.resolve();
    const data = pendingSave;
    pendingSave = null;
    clearTimeout(saveTimer);
    clearTimeout(retryTimer);
    const keepalive = leaving === true && new TextEncoder().encode(data).length <= KEEPALIVE_MAX;
    return api('state', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: data, keepalive })
      .then((r) => r.json().catch(() => ({})).then((j) => ({ r, j })), () => ({ r: null, j: {} }))
      .then(({ r, j }) => {
        if (r && r.ok) {
          retryIn = 0;
          unsaved('');
          if (j.snapshot && (!CONFIG.snapshot || j.snapshot.commit !== CONFIG.snapshot.commit)) { CONFIG.snapshot = j.snapshot; renderSide(); }
          return;
        }
        unsaved(!r ? 'untangle doesn’t answer: is it still running?' : r.status === 403 ? 'This page is from another run of untangle: open the link it printed.' : j.error || `untangle couldn’t save them (${r.status}).`);
        // A save that didn't get there goes again a little later, unless a newer one is on its way.
        if ((!r || r.status >= 500) && pendingSave == null) {
          pendingSave = data;
          retryIn = Math.min(60_000, retryIn ? retryIn * 2 : 5_000);
          retryTimer = setTimeout(flushSave, retryIn);
        }
      });
  }
  function save() {
    const data = JSON.stringify({ rev: Object.fromEntries(Object.entries(state.rev).map(([k, v]) => [k, [...v]])), cmarks: [...state.cmarks], layout: state.layout, showReviewedDiff: state.showReviewedDiff });
    if (CONFIG.served) {
      clearTimeout(saveTimer);
      pendingSave = data;
      saveTimer = setTimeout(flushSave, 300);
      return;
    }
    try { localStorage.setItem(STORE, data); } catch (e) { /* storage unavailable */ }
  }
  window.addEventListener('pagehide', () => flushSave(true));
  // This browser's layout: the sidebar's width and whether it shows, the minimap, a commit's files
  // as a tree or a list, and the Threads tab's folded sections.
  const UI_KEY = 'untangle:ui';
  const UI = { side: 272, sideOff: false, minimap: true, filesList: false, foldedThreads: [] };
  // Contents, open over the view in a narrow window, and the view it was opened on.
  const SIDE = { open: false, at: '' };
  try { Object.assign(UI, JSON.parse(localStorage.getItem(UI_KEY) || '{}')); } catch (e) { /* storage unavailable */ }
  const saveUI = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(UI)); } catch (e) { /* storage unavailable */ } };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(true); });

  // ---------- model
  const models = {};
  // A hunk's rows, to the hunk: what its first line starts inside on each side (so, sn), when that's
  // a string or a comment that an earlier line opened (see rowsColors).
  const hunkOfRows = new WeakMap();
  function M(name) {
    name = name || state.compare;
    if (models[name]) return models[name];
    const raw = MODEL.compares[name];
    const m = { name, raw, files: raw.files, edits: raw.edits, groups: raw.groups, chains: raw.chains, generated: raw.generated };
    m.unitById = new Map((raw.units || []).map((unit) => [unit.id, unit]));
    m.blockById = new Map();
    m.head = new Map();
    m.old = new Map();
    m.files.forEach((f, fi) => {
      f.idx = fi;
      f.hunks.forEach((h) => {
        hunkOfRows.set(h.rows, h);
        let o = h.o, n = h.n;
        h.meta = h.rows.map(([t]) => { const r = { t, o: t !== '+' ? o : null, n: t !== '-' ? n : null, block: null }; if (t !== '+') o++; if (t !== '-') n++; return r; });
      });
      f.blocks.forEach((b) => {
        b.file = f;
        m.blockById.set(b.id, b);
        const h = f.hunks[b.hunk];
        for (let i = b.first; i < b.first + b.len; i++) h.meta[i].block = b;
        b.firstRowOfEdit = new Map();
        for (let i = b.first; i < b.first + b.len; i++) (h.rows[i][2] || []).forEach(([, , id]) => { if (!b.firstRowOfEdit.has(id)) b.firstRowOfEdit.set(id, i); });
      });
      f.hunks.forEach((h, hi) => h.meta.forEach((r, ri) => { if (r.n != null) m.head.set(f.p + ':' + r.n, { f, hi, ri, r }); if (r.o != null && r.t !== '+') m.old.set(f.p + ':' + r.o, { f, hi, ri, r }); }));
    });
    m.generated.forEach((g) => (g.hunks || []).forEach((h) => hunkOfRows.set(h.rows, h)));
    m.groupById = new Map(m.groups.map((g) => [g.id, g]));
    m.chainsOf = new Map();
    m.chains.forEach((c) => {
      c.blockSet = new Set(c.blocks);
      c.blocks.forEach((id) => { if (!m.chainsOf.has(id)) m.chainsOf.set(id, []); m.chainsOf.get(id).push(c.id); });
      c.graph.nodes.forEach((n, i) => { n.idx = i; });
    });
    m.usedBy = new Map(m.chains.map((c) => [c.id, []]));
    m.chains.forEach((c) => c.uses.forEach((o) => m.usedBy.get(o).push(c.id)));
    const fams = new Map();
    m.chains.forEach((c) => { if (!fams.has(c.family)) fams.set(c.family, []); fams.get(c.family).push(c); });
    const family = (id, list) => {
      list.sort((x, y) => x.depth - y.depth || y.blocks.length - x.blocks.length || (x.name < y.name ? -1 : 1));
      const top = list.slice().sort((x, y) => y.blocks.length - x.blocks.length || x.id - y.id)[0];
      return { id, chains: list, top, depth: Math.max(...list.map((c) => c.depth)) };
    };
    // By commit, a family is a commit's chain, in the order the commits were made; the renames
    // come last.
    m.byCommit = !!raw.families;
    m.families = m.byCommit
      ? raw.families.filter((f) => fams.has(f.id)).map((f) => ({ ...family(f.id, fams.get(f.id)), commit: f.same ? null : f, same: !!f.same }))
      : [...fams.entries()].map(([id, list]) => family(id, list)).sort((x, y) => y.chains.length - x.chains.length || x.id - y.id);
    m.byMember = new Map();
    m.files.forEach((f) => f.blocks.forEach((b) => { if (b.edits.length && b.mk && !/::\(top\)$/.test(b.mk)) { if (!m.byMember.has(b.mk)) m.byMember.set(b.mk, []); m.byMember.get(b.mk).push(b); } }));
    m.standalone = [];
    m.files.forEach((f) => f.blocks.forEach((b) => { if (b.edits.length && !m.chainsOf.has(b.id)) m.standalone.push(b); }));
    m.usageByLine = new Map();
    Object.entries(REFS[name] || {}).forEach(([key, list]) => {
      const i1 = key.lastIndexOf(':'), i0 = key.lastIndexOf(':', i1 - 1);
      const k = key.slice(0, i1);
      if (!m.usageByLine.has(k)) m.usageByLine.set(k, []);
      m.usageByLine.get(k).push([key, list.length]);
    });
    models[name] = m;
    return m;
  }

  // ---------- review helpers
  const rev = () => state.rev[state.compare] || (state.rev[state.compare] = new Set());
  const done = (b) => b.edits.every((id) => rev().has(id));
  function setEdits(ids, on) { ids.forEach((id) => (on ? rev().add(id) : rev().delete(id))); save(); }

  // ---------- the lens: the review through some commits. The changes of a commit or a range
  // (blame says which commit wrote each line), or everything since an older head (your last
  // review, the head before a force push), which a diff from it says. Lines outside it fade, and
  // the counts, the pill, the minimap and the keys go through what's in it. Under a commit's
  // lens, marking a change marks the lines that commit wrote; since a head, the whole change.
  // state.lens: { kind: 'commits', shas } or { kind: 'since', from, why: 'review' | 'push' }.
  const HX = HISTORY && HISTORY.commits && HISTORY.commits.length
    ? { index: new Map(HISTORY.commits.map((c, i) => [c.sha, i])), live: null, liveAt: 0, loading: null, since: new Map(), brought: new Map(), open: new Set(), detail: null, closed: new Set() }
    : null;
  let lensMemo = null;
  const lensOn = () => !!state.lens;
  function lensData() {
    const ln = state.lens;
    if (!ln) return null;
    if (lensMemo && lensMemo.lens === ln) return lensMemo;
    lensMemo = { lens: ln, set: ln.kind === 'commits' ? new Set(ln.shas.map((x) => HX.index.get(x)).filter((i) => i != null)) : null, rows: ln.kind === 'since' ? HX.since.get(ln.from) || {} : null, blocks: new Map(), tick: new Map() };
    return lensMemo;
  }
  // Which commit wrote a row of a file's hunk (an index into the history), or -1.
  const rowCommit = (f, hi, ri) => { const a = HISTORY && HISTORY.rows[f.idx]; const v = a && a[hi] ? a[hi][ri] : -1; return v == null ? -1 : v; };
  // The same, for a row drawn in a view: only the review against the base has the history's rows.
  const wroteRow = (f, hi, ri) => (hxOn() ? rowCommit(f, hi, ri) : -1);
  function rowInLens(f, hi, ri) {
    const d = lensData();
    if (!d) return true;
    if (d.set) return d.set.has(rowCommit(f, hi, ri));
    const r = d.rows[f.idx] && d.rows[f.idx][hi];
    return !!r && r.has(ri);
  }
  // The commits that wrote lines of a change (indices into the history).
  const blockCommitsMemo = new Map();
  function blockCommits(b) {
    let set = blockCommitsMemo.get(b.id);
    if (!set) {
      set = new Set();
      const h = b.file.hunks[b.hunk];
      if (HISTORY) for (let ri = b.first; ri < b.first + b.len; ri++) if (h.rows[ri][0] !== ' ') { const ci = rowCommit(b.file, b.hunk, ri); if (ci >= 0) set.add(ci); }
      blockCommitsMemo.set(b.id, set);
    }
    return set;
  }
  // Who wrote a chain: for each commit (an index into the history), the chain's changed lines it
  // last wrote and how many of the chain's changes have some.
  const writersMemo = new WeakMap();
  function chainWriters(c) {
    let w = writersMemo.get(c);
    if (w) return w;
    w = new Map();
    if (HISTORY) blocksOf(c.blocks).forEach((b) => {
      const h = b.file.hunks[b.hunk], seen = new Set();
      for (let ri = b.first; ri < b.first + b.len; ri++) {
        if (h.rows[ri][0] === ' ') continue;
        const ci = rowCommit(b.file, b.hunk, ri);
        if (ci < 0) continue;
        if (!w.has(ci)) w.set(ci, { lines: 0, changes: 0 });
        w.get(ci).lines++;
        seen.add(ci);
      }
      seen.forEach((ci) => { w.get(ci).changes++; });
    });
    writersMemo.set(c, w);
    return w;
  }
  const cmKey = (b, ci) => b.id + '@' + HISTORY.commits[ci].sha;
  // A change's lines from a commit are reviewed: marked so, or the whole change is.
  const commitDone = (b, ci) => done(b) || state.cmarks.has(cmKey(b, ci));
  const commitLens = () => !!state.lens && state.lens.kind === 'commits';
  // A change under the lens: whether it's in it, and (a commit's lens) the lens's commits in it.
  function lensBlock(b) {
    const d = lensData();
    if (!d) return { in: true, commits: [] };
    let x = d.blocks.get(b.id);
    if (!x) {
      if (d.set) { const commits = [...blockCommits(b)].filter((ci) => d.set.has(ci)); x = { in: b.edits.length > 0 && commits.length > 0, commits }; }
      else {
        let any = false;
        for (let ri = b.first; ri < b.first + b.len && !any; ri++) any = b.file.hunks[b.hunk].rows[ri][0] !== ' ' && rowInLens(b.file, b.hunk, ri);
        x = { in: b.edits.length > 0 && any, commits: [] };
      }
      d.blocks.set(b.id, x);
    }
    return x;
  }
  const blockIn = (b) => !lensOn() || lensBlock(b).in;
  // Done as the lens sees it: under a commit's lens, when its lines in the change are reviewed.
  const doneL = (b) => (commitLens() && blockIn(b) ? lensBlock(b).commits.every((ci) => commitDone(b, ci)) : done(b));
  // Marks (or unmarks) the lens's commits' lines in changes. A change all of whose commits are
  // marked is reviewed; one unmarked while reviewed keeps its other commits' lines reviewed.
  function markCommitLines(blocks, on) {
    blocks.forEach((b) => {
      const lensCommits = lensBlock(b).commits, all = [...blockCommits(b)];
      if (on) {
        lensCommits.forEach((ci) => state.cmarks.add(cmKey(b, ci)));
        if (all.every((ci) => state.cmarks.has(cmKey(b, ci)))) b.edits.forEach((id) => rev().add(id));
      } else {
        if (done(b)) { all.forEach((ci) => state.cmarks.add(cmKey(b, ci))); b.edits.forEach((id) => rev().delete(id)); }
        lensCommits.forEach((ci) => state.cmarks.delete(cmKey(b, ci)));
      }
    });
    save();
  }
  const clearCommitMarks = (b) => { if (HISTORY) blockCommits(b).forEach((ci) => state.cmarks.delete(cmKey(b, ci))); };
  // The row a change's mark sits on: its first row, or its first row in the lens.
  // The row a change's mark sits on: its first changed line that isn't blank (under a lens, in the
  // lens; with its diff hidden, an added one), else its first changed line.
  function tickRow(b, quiet) {
    const d = lensData(), lens = !!d && blockIn(b);
    const cache = lens ? d.tick : b.ticks || (b.ticks = new Map()), key = (lens ? b.id : '') + (quiet ? ':q' : '');
    if (!cache.has(key)) {
      const h = b.file.hunks[b.hunk];
      let at = -1;
      for (let ri = b.first; ri < b.first + b.len; ri++) {
        const [t, text] = h.rows[ri];
        if (t === ' ' || (quiet && t === '-') || (lens && !rowInLens(b.file, b.hunk, ri))) continue;
        if (at < 0) at = ri;
        if (text.trim()) { at = ri; break; }
      }
      cache.set(key, at < 0 ? b.first : at);
    }
    return cache.get(key);
  }
  // A row drawn with the lens on and outside it.
  const lensOut = (f, hi, ri) => lensOn() && !rowInLens(f, hi, ri);
  function stats(blocks) {
    const s = { total: 0, open: 0, lines: 0, all: 0 };
    const lens = lensOn();
    const units = new Set(), open = new Set();
    blocks.forEach((b) => {
      if (!b.edits.length || (lens && !blockIn(b))) return;
      const key = b.unit || b.id;
      units.add(key);
      s.all += b.adds + b.dels;
      if (!doneL(b)) {
        open.add(key);
        s.lines += b.adds + b.dels;
      }
    });
    s.total = units.size;
    s.open = open.size;
    return s;
  }
  // The same, as if no lens were on.
  function withoutLens(fn) {
    const ln = state.lens, memo = lensMemo;
    state.lens = null;
    try { return fn(); } finally { state.lens = ln; lensMemo = memo; }
  }
  const blocksOf = (ids) => ids.map((id) => M().blockById.get(id));
  // Marks or unmarks changes: under a lens, the ones in it (a change outside it, when that's all
  // there is: its mark was clicked).
  function toggleBlocks(blocks) {
    const inside = lensOn() ? blocks.filter(blockIn) : blocks;
    const list = inside.length ? inside : blocks;
    const anyOpen = list.some((b) => !doneL(b));
    if (commitLens() && inside.length) markCommitLines(list, anyOpen);
    else {
      setEdits(list.flatMap((b) => b.edits), anyOpen);
      if (!anyOpen) list.forEach(clearCommitMarks);
    }
    list.forEach((b) => state.blockDiff.delete(b.id));
  }

  // ---------- labels
  function memberParts(member) {
    if (!member) return { owner: '', name: '' };
    const i = member.indexOf('.');
    return i < 0 ? { owner: '', name: member } : { owner: member.slice(0, i), name: member.slice(i + 1) };
  }
  function editText(id) {
    const e = M().edits[id];
    const side = (s) => trunc(s.replace(/\s+/g, ' '), 46);
    if (e.op === 'insert') return '+ ' + side(e.to);
    if (e.op === 'delete') return '− ' + side(e.from);
    return side(e.from) + ' → ' + side(e.to);
  }
  function groupLabel(g) { return g.parts.map(editText).join(' … '); }
  function nodeLabels(n) {
    if (n.unit) {
      const unit = M().unitById.get(n.unit);
      if (unit) return { l1: fileName(n.file), l2: unit.name, owner: '' };
    }
    if (n.tests != null) return { l1: 'tests', l2: `${fileName(n.file)} · ${n.tests ? `${n.tests} test${n.tests === 1 ? '' : 's'}` : 'setup'}`, owner: '' };
    if (n.group !== null && n.group !== undefined) {
      const g = M().groupById.get(n.group);
      return { l1: `same change · ${n.files} file${n.files > 1 ? 's' : ''}`, l2: g ? groupLabel(g) : '' };
    }
    const { owner, name } = memberParts(n.member);
    if (!n.member || n.member === 'main') return { l1: TEST_FILE.test(n.file) ? 'test file' : 'top level', l2: fileName(n.file), owner: '' };
    return { l1: fileName(n.file), l2: name, owner };
  }
  const kindWord = { member: 'changed member', type: 'changed type', param: 'parameter ripple', local: 'variable ripple' };

  // ---------- syntax colors: Shiki once it has loaded (VS Code's grammars and Dark+), the
  // tokenizer's classes until then. A run of rows is highlighted as two pieces of code, its new
  // side (context and added lines) and its old side (context and removed lines), so strings and
  // comments over several lines keep their colors; one that starts inside a string or a comment an
  // earlier line opened starts from what opened it (the analysis tells which: so, sn).
  const SHIKI = window.UntangleShiki || null;
  let shikiOn = false;
  // The theme's color for text no grammar rule colors (a bundle from before it said so: Dark+'s).
  let shikiFg = '#D4D4D4';
  const rowsColorCache = new WeakMap();
  function rowsColors(rows, path) {
    if (!shikiOn) return null;
    if (rowsColorCache.has(rows)) return rowsColorCache.get(rows);
    const lang = SHIKI.langFor(path);
    let out = null;
    if (lang) {
      const neu = [], old = [];
      rows.forEach((r, i) => { if (r[0] !== '-') neu.push(i); if (r[0] !== '+') old.push(i); });
      // Highlighted after what's open where the side starts, on a line of its own, then left out.
      const h = hunkOfRows.get(rows) || {};
      const side = (idx, open) => {
        const text = idx.map((i) => rows[i][1]).join('\n');
        const c = SHIKI.lines(open ? open + '\n' + text : text, lang);
        return c && open ? c.slice(1) : c;
      };
      const nl = side(neu, h.sn), ol = side(old, h.so);
      out = { neu: [], old: [] };
      if (nl) neu.forEach((ri, k) => { out.neu[ri] = nl[k]; });
      if (ol) old.forEach((ri, k) => { out.old[ri] = ol[k]; });
    }
    rowsColorCache.set(rows, out);
    return out;
  }
  const rowColors = (rows, path, i) => { const c = rowsColors(rows, path); return c ? (rows[i][0] === '-' ? c.old[i] : c.neu[i]) || null : null; };
  const textColorCache = new Map();
  // Colors of each line of a text (a whole file, a snippet), cached by its content.
  function textColors(text, path) {
    if (!shikiOn) return null;
    const lang = SHIKI.langFor(path);
    if (!lang) return null;
    const k = lang + '\0' + text;
    if (!textColorCache.has(k)) { if (textColorCache.size > 400) textColorCache.clear(); textColorCache.set(k, SHIKI.lines(text, lang)); }
    return textColorCache.get(k);
  }
  const lineColors = (text, path) => { const c = textColors(text, path); return c ? c[0] : null; };
  // A class per color the theme uses (a rule added the first time), lighter than a style per token.
  const colorClasses = new Map();
  let colorSheet = null;
  function colorClass(color, italic) {
    const k = color + (italic ? ' i' : '');
    if (!colorClasses.has(k)) {
      if (!/^#[0-9a-f]{3,8}$/i.test(color)) return '';
      const name = 'k' + colorClasses.size;
      colorClasses.set(k, name);
      if (!colorSheet) { colorSheet = document.createElement('style'); document.head.appendChild(colorSheet); }
      colorSheet.sheet.insertRule(`.${name}{color:${color};font-style:${italic ? 'italic' : 'normal'}}`, colorSheet.sheet.cssRules.length);
    }
    return colorClasses.get(k);
  }
  function colorAt(colors, col) {
    let lo = 0, hi = colors.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (colors[mid][0] <= col) { best = colors[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best;
  }

  // ---------- code rendering
  function lineDefs(path, n) {
    const D = defsNow();
    const arr = n != null && D.defs[path] && D.defs[path][n];
    return arr ? new Map(arr.map(([c, , ti]) => [c, ti])) : null;
  }
  function oldLineDefs(path, o) {
    const d = DEFS_OLD[state.compare];
    const arr = o != null && d && d.defs[path] && d.defs[path][o];
    return arr ? new Map(arr.map(([c, , ti]) => [c, ti])) : null;
  }
  // A line of code as tokens. opts: emphasis (mark changed tokens), refs with n or o (definitions
  // answered ahead of time on that line), colors (the line's Shiki colors, else the line alone is
  // highlighted), live ({ side, p, ext, line }: any other name asks the server where it's defined),
  // find (a query, marked wherever it matches).
  function codeHtml(f, text, ranges, opts) {
    const toks = C.tokenize(text, f.lang, { interpolations: true });
    // The changes' tokens, as the analysis split the line: a name in a string's interpolation is
    // a token here, inside the string's word there.
    const markAt = ranges && opts.emphasis ? (c) => { const r = ranges.find(([s, e]) => s <= c && c < e); return r && r[2]; } : null;
    const defs = !opts.refs ? null : opts.n != null ? lineDefs(f.p, opts.n) : opts.o != null ? oldLineDefs(f.p, opts.o) : null;
    const colors = opts.colors || lineColors(text, f.p);
    const live = CONFIG.served ? opts.live || (opts.refs && opts.n != null ? { side: 'head', p: f.p, line: opts.n } : opts.refs && opts.o != null ? { side: 'base', p: f.p, line: opts.o } : null) : null;
    const nextCode = (i) => { for (let j = i + 1; j < toks.length; j++) if (toks[j].k !== 'ws') return toks[j]; return null; };
    const found = opts.find ? matchesOf(text, opts.find) : null;
    const show = (tk) => (found ? markIn(tk.t, tk.c, found) : esc(tk.t));
    const refAttrs = (ti, col, title) => ` data-ti="${ti}" data-col="${col}" data-path="${esc(f.p)}"${opts.n != null ? ` data-n="${opts.n}" title="${title}"` : ` data-o="${opts.o}" title="${title} (old side)"`}`;
    const liveAttrs = (col, title) => ` data-ls="${live.side || ''}" data-lp="${esc(live.p || '')}" data-lx="${live.ext != null ? live.ext : ''}" data-ll="${live.line}" data-lc="${col}" title="${title}"`;
    // An import's or export's URI, one link around its string's tokens to the file it names.
    const uri = f.lang === 'dart' && (defs || live) ? uriOf(toks) : null;
    let uriOpen = '';
    if (uri) {
      const col = toks[uri[0]].c, ti = defs ? defs.get(col) : undefined;
      if (ti !== undefined) uriOpen = `<span class="ref uri"${refAttrs(ti, col, 'Peek the file')}>`;
      else if (live) uriOpen = `<span class="ref live uri"${liveAttrs(col + toks[uri[0]].t.length, 'Go to the file')}>`;
    }
    return toks.map((tk, i) => {
      if (tk.k === 'ws') return show(tk);
      let cls = 't-' + tk.k, attrs = '';
      if (tk.k === 'id') { const nx = nextCode(i); if (nx && (nx.t === '(' || nx.t === '<')) cls = 't-fn'; }
      const mark = markAt && markAt(tk.c);
      if (mark != null) cls += rev().has(mark) ? ' rv' : ' ch';
      if (colors) {
        const c = colorAt(colors, tk.c);
        // Grammars leave plain names (variables, properties, parameters) in the default color;
        // VS Code colors them from the language server. The tokenizer's classes stand in there.
        const plain = !c || !c[1] || (c[1].toUpperCase() === shikiFg && (tk.k === 'id' || tk.k === 'ty'));
        if (!plain) cls += ' ' + colorClass(c[1], c[2]);
      }
      if (tk.k === 'id' || tk.k === 'ty' || tk.k === 'ann') {
        const col = tk.k === 'ann' ? tk.c + 1 : tk.c;
        const ti = defs ? defs.get(col) : undefined;
        if (ti !== undefined) { cls += ' ref'; attrs += refAttrs(ti, col, 'Peek definition'); }
        else if (live) { cls += ' ref live'; attrs += liveAttrs(col, 'Go to definition'); }
      }
      const span = `<span class="${cls}"${attrs}>${show(tk)}</span>`;
      return !uriOpen ? span : i === uri[0] ? uriOpen + span : i === uri[1] ? span + '</span>' : span;
    }).join('');
  }
  // Where a query matches a line, as [start, end) columns: case-insensitive when it's lower case.
  function matchesOf(text, q) {
    const hay = q === q.toLowerCase() ? text.toLowerCase() : text;
    const out = [];
    for (let i = q ? hay.indexOf(q) : -1; i >= 0; i = hay.indexOf(q, i + q.length)) out.push([i, i + q.length]);
    return out;
  }
  // A token's text, at column c, with the matches in it marked: a match across tokens is marked in each.
  function markIn(t, c, found) {
    let out = '', at = 0;
    for (const [s, e] of found) {
      const a = Math.max(0, s - c), b = Math.min(t.length, e - c);
      if (a >= b) continue;
      out += esc(t.slice(at, a)) + '<mark>' + esc(t.slice(a, b)) + '</mark>';
      at = b;
    }
    return out + esc(t.slice(at));
  }
  // An import's or export's URI: the indexes of its string's opening and closing quotes.
  function uriOf(toks) {
    const code = [];
    for (let i = 0; i < toks.length && code.length < 2; i++) if (toks[i].k !== 'ws') code.push(i);
    if (code.length < 2 || (toks[code[0]].t !== 'import' && toks[code[0]].t !== 'export')) return null;
    const open = code[1];
    if (toks[open].k !== 'str' || !/^r?['"]$/.test(toks[open].t)) return null;
    const q = toks[open].t.slice(-1);
    for (let j = open + 1; j < toks.length; j++) if (toks[j].k === 'str' && toks[j].t === q) return [open, j];
    return null;
  }
  function badgesHtml(f, b, ri, n) {
    let h = '';
    if (b) {
      const seen = new Set();
      b.edits.forEach((id) => {
        const e = M().edits[id];
        if (e.group === undefined || e.group === null || b.firstRowOfEdit.get(id) !== ri || seen.has(e.group)) return;
        seen.add(e.group);
        const g = M().groupById.get(e.group);
        const ok = g.edits.every((x) => rev().has(x));
        h += `<button type="button" class="bdg${ok ? ' ok' : ''}" data-group="${g.id}" title="The same change in ${g.count} places: see them all">same change ×${g.count}</button>`;
      });
    }
    if (n != null) (M().usageByLine.get(f.p + ':' + n) || []).forEach(([key, cnt]) => {
      h += `<button type="button" class="bdg" data-usage="${esc(key)}" title="Usages inside other changes, from the language server">${cnt} changed usage${cnt > 1 ? 's' : ''}</button>`;
    });
    return h;
  }
  function tickHtml(b) {
    const d = doneL(b);
    return `<button type="button" class="tick${d ? ' on' : ''}${lensOn() && !blockIn(b) ? ' lens-out' : ''}" data-act="toggle-block" data-block="${esc(b.id)}" title="${d ? 'Reviewed: mark unreviewed' : 'Mark this change reviewed (Space)'}" aria-label="${d ? 'Mark unreviewed' : 'Mark this change reviewed'}" aria-pressed="${d}"></button>`;
  }
  function diffToggle(b) {
    const shown = state.blockDiff.has(b.id) || state.showReviewedDiff;
    return state.showReviewedDiff ? '' : `<button type="button" class="bdg" data-act="toggle-diff" data-block="${esc(b.id)}" title="${shown ? 'Read this reviewed change as plain code again' : 'Show what this reviewed change changed'}">${shown ? 'hide diff' : 'show diff'}</button>`;
  }
  function peekAfter(f, n) {
    return state.peek && !state.peek.old && state.peek.path === f.p && state.peek.n === n ? peekHtml(state.peek) : '';
  }
  function peekAfterOld(f, o) {
    return state.peek && state.peek.old && state.peek.path === f.p && state.peek.o === o ? peekHtml(state.peek) : '';
  }
  // One unified row, with one line number: the new line's, or the old one's for a removed line.
  // o.c: the row takes comments (a line of the pull request's diff). o.w: the commit that wrote it.
  function uRow(f, meta, text, ranges, o) {
    const sign = o.sign != null ? o.sign : meta.t === '+' ? '+' : meta.t === '-' ? '−' : '';
    const n = meta.t !== '-' ? meta.n : null;
    const oldNo = meta.t === '-' ? meta.o : null;
    const c = o.c ? (meta.t === '-' ? (o.mv ? '' : 'L:' + meta.o) : n != null ? 'R:' + n : '') : '';
    const notes = (o.badges || '') + (o.toggle || '');
    return `<div class="ln ${o.cls}${f.lang === 'md' ? ' md' : ''}${o.sel ? ' cm-sel' : ''}${o.mark || ''}"${indentAttr(text)}${n != null ? ` data-n="${n}"` : ''}${c ? ` data-c="${c}"` : ''}${o.w >= 0 ? ` data-w="${o.w}"` : ''}><span class="g">${o.tick || ''}</span><span class="no">${n != null ? n : meta.o != null ? meta.o : ''}</span><span class="sg">${sign}</span><span class="tx">${codeHtml(f, text, ranges, { emphasis: o.emphasis, n, o: oldNo, refs: o.refs, colors: o.colors })}</span>${notes ? `<span class="bdgs">${notes}</span>` : ''}</div>` + (n != null ? peekAfter(f, n) : oldNo != null ? peekAfterOld(f, oldNo) : '') + (o.c ? threadsRow(f, meta, o.mv) : '');
  }
  // Each move annotation stays at the moved block's position. The removed body stays
  // collapsed; the added body's annotation immediately precedes its rows.
  function moveLines(b, old) {
    const meta = b.file.hunks[b.hunk].meta.slice(b.first, b.first + b.len);
    const ns = meta.map((r) => old ? r.o : r.n).filter((n) => n != null);
    return `${old ? 'Old l' : 'L'}ine${ns.length > 1 ? 's' : ''} ${ns[0]}${ns.length > 1 ? '–' + ns[ns.length - 1] : ''}`;
  }
  // A move's note links to its other copy: a click shows that copy here, under the note, and "Go
  // to it" there goes to it.
  const moveLink = (b, label) => `<button type="button" class="linkish" data-act="move-peek" data-block="${esc(b.id)}" aria-expanded="${!!(state.peek && state.peek.moveOf === b.id)}" title="Show it here">${label}</button>`;
  const movePeekAfter = (b) => (state.peek && state.peek.moveOf === b.id ? peekHtml(state.peek) : '');
  function movedAwayHtml(b) {
    const to = M().files[b.movedTo.f];
    const what = b.movedTo.changes ? `with ${b.movedTo.changes} change${b.movedTo.changes > 1 ? 's' : ''}` : 'unchanged';
    return `<div class="ln mv-away"><span class="g"></span><span class="no"></span><span class="sg">↦</span><span class="tx">${b.len} line${b.len > 1 ? 's' : ''} moved to ${moveLink(b, `${esc(fileName(to.p))}:${b.movedTo.n}`)}, ${what} · ${moveLines(b, true)}</span></div>` + movePeekAfter(b);
  }
  function movedHeadHtml(f, b) {
    const from = M().files[b.move.f];
    const fromBlock = M().blockById.get(b.move.b);
    const fromLine = fromBlock ? from.hunks[fromBlock.hunk].meta[fromBlock.first].o : '';
    const d = done(b);
    const open = state.moveOpen.has(b.id);
    const groups = new Set(b.edits.map((id) => M().edits[id].group).filter((g) => g != null));
    let h = `<div class="ln mv-head${d && b.edits.length ? ' rvd' : ''}"><span class="g">${b.edits.length ? tickHtml(b) : ''}</span><span class="no"></span><span class="sg">↤</span><span class="tx">Moved from ${moveLink(b, `${esc(fileName(from.p))}:${fromLine}`)} · ${moveLines(b, false)} · ${b.edits.length ? `${b.edits.length} change${b.edits.length > 1 ? 's' : ''}` : 'no changes'}</span><span class="bdgs">`
      + [...groups].map((g) => { const gr = M().groupById.get(g); return `<button type="button" class="bdg" data-group="${g}">same change ×${gr.count}</button>`; }).join('')
      + `<button type="button" class="bdg" data-act="toggle-move" data-block="${esc(b.id)}">${open ? 'fold the moved lines' : 'show the moved lines'}</button></span></div>`;
    return h + movePeekAfter(b);
  }
  // Where a move's other copy is: the lines it moved to, at the head, or the ones it came from, at
  // the base; the moved lines marked, and the lines around them from the diff until the file loads.
  function moveTarget(b) {
    const away = !!b.movedTo;
    const other = away ? M().blockById.get(b.movedTo.b) : M().blockById.get(b.move.b);
    const file = M().files[away ? b.movedTo.f : b.move.f];
    const lines = other ? other.file.hunks[other.hunk].meta.slice(other.first, other.first + other.len).map((r) => (away ? r.n : r.o)).filter((x) => x != null) : [];
    const l = away ? b.movedTo.n : lines[0];
    return { away, p: file.p, side: away ? 'head' : 'base', l, mark: lines.length ? [lines[0], lines[lines.length - 1]] : null, around: other ? moveAroundHtml(other, !away) : '' };
  }
  function moveAroundHtml(blk, old) {
    const h = blk.file.hunks[blk.hunk];
    let out = '';
    for (let i = Math.max(0, blk.first - 3); i < Math.min(h.rows.length, blk.first + blk.len + 3); i++) {
      const r = h.meta[i];
      if (old ? r.t === '+' : r.t === '-') continue;
      const ln = old ? r.o : r.n;
      out += `<div class="pk-ln${i >= blk.first && i < blk.first + blk.len ? ' mvr' : ''}" data-n="${ln}"><span class="no">${ln}</span><span class="tx">${codeHtml(blk.file, h.rows[i][1], null, { colors: rowColors(h.rows, blk.file.p, i) })}</span></div>`;
    }
    return out;
  }
  function movePeekHtml(p) {
    const b = M().blockById.get(p.moveOf);
    const t = moveTarget(b);
    const where = t.away ? (b.movedTo.changes ? `with ${plural(b.movedTo.changes, 'change')}` : 'unchanged') : `old side · ${(CONFIG.base || M().raw.left || '').slice(0, 7)}`;
    return `<div class="pk-h"><b>${t.away ? 'Moved to' : 'Moved from'}</b><span class="pk-loc">${esc(t.p)}:${t.l}</span><span class="pk-src">${esc(where)}</span><span class="sp"></span>`
      + `<button type="button" class="btn xs primary" data-open="${esc(t.p)}" data-line="${t.l}">Go to it</button><button type="button" class="pk-x" data-act="close-peek">Close</button></div>`
      + peekCodeHtml({ p: t.p, side: t.side, l: t.l, mark: t.mark }, t.around);
  }
  // The added copy compares the two bodies: unchanged lines are purple; edits stay red/green.
  function movedHtml(f, b, ctx) {
    const from = M().files[b.move.f];
    const rows = b.move.rows, d = done(b), open = state.moveOpen.has(b.id);
    let h = movedHeadHtml(f, b);
    // Keep each change with 3 lines of context; fold the rest unless opened.
    const keep = new Set();
    rows.forEach((r, i) => { if (r[0] !== ' ') for (let k = Math.max(0, i - 3); k <= Math.min(rows.length - 1, i + 3); k++) keep.add(k); });
    const fromFile = { p: from.p, lang: f.lang };
    let skipped = 0;
    const flush = () => { if (skipped) h += `<div class="ln skip mv"><span class="g"></span><span class="no"></span><span class="sg"></span><span class="tx">${skipped} moved line${skipped > 1 ? 's' : ''}, unchanged</span></div>`; skipped = 0; };
    rows.forEach(([t, text, o, n, ranges], i) => {
      if (!open && !keep.has(i)) { skipped++; return; }
      flush();
      const meta = { t: t === ' ' ? ' ' : t, o: t === '+' ? null : o, n: t === '-' ? null : n };
      const colors = rowColors(rows, f.p, i);
      // The new copy's lines are added lines of this file; the removed ones are another file's.
      if (t === ' ') h += uRow(f, { t: ' ', o, n }, text, null, { cls: 'mv' + (d ? ' rvd' : ''), sign: '', refs: !ctx.noRefs, colors, c: true, mv: true });
      else if (t === '-') h += uRow(fromFile, meta, text, ranges, { cls: 'del' + (d ? ' rvd' : ''), emphasis: true, refs: !ctx.noRefs, colors });
      else h += uRow(f, meta, text, ranges, { cls: 'add' + (d ? ' rvd' : ''), emphasis: true, refs: !ctx.noRefs, colors, c: true });
    });
    flush();
    return h;
  }
  // Rows [start, end) of a hunk. Reviewed changes stay visible: by default their diff is
  // hidden and the new code reads as muted context.
  function rowsHtml(f, hi, start, end, ctx) {
    ctx = ctx || {};
    const h = f.hunks[hi];
    let out = '';
    const placed = new Set();
    for (let ri = start; ri < end; ri++) {
      const meta = h.meta[ri];
      const [t, text, ranges] = h.rows[ri];
      const colors = rowColors(h.rows, f.p, ri);
      const b = meta.block;
      if (b && (b.move || b.movedTo)) {
        if (!placed.has(b.id)) { placed.add(b.id); out += b.move ? movedHtml(f, b, ctx) : movedAwayHtml(b); }
        // A block moved away is one row here; threads on its removed lines still show.
        if (b.movedTo) out += threadsAt(f, 'LEFT', meta.o);
        continue;
      }
      const sel = inCompose(f, hi, ri), mark = markAt(f, hi, ri);
      if (!b || !b.edits.length) { out += uRow(f, meta, text, null, { cls: 'ctx', refs: !ctx.noRefs, colors, c: true, sel, mark }); continue; }
      const d = done(b);
      const showDiff = !d || state.showReviewedDiff || state.blockDiff.has(b.id);
      const other = (ctx.unit && b.unit !== ctx.unit) || (ctx.chain && !ctx.chain.blockSet.has(b.id)) ? ' other' : '';
      const emphasis = b.adds > 0 && b.dels > 0;
      if (!showDiff) {
        if (t === '-') {
          if (b.adds === 0 && !placed.has(b.id)) {
            placed.add(b.id);
            out += `<div class="ln gone"><span class="g">${tickHtml(b)}</span><span class="no"></span><span class="sg"></span><span class="tx">${b.dels} removed line${b.dels > 1 ? 's' : ''}, reviewed</span><span class="bdgs">${diffToggle(b)}</span></div>`;
          }
          // The removed line is hidden; its threads aren't.
          out += threadsAt(f, 'LEFT', meta.o);
          continue;
        }
        const want = tickRow(b, true), first = want >= start && want < end ? ri === want : !placed.has(b.id);
        placed.add(b.id);
        out += uRow(f, meta, text, null, { cls: 'ctx rvd-quiet' + other + (lensOut(f, hi, ri) ? ' lens-out' : ''), sign: '', tick: first ? tickHtml(b) : '', toggle: first ? diffToggle(b) : '', refs: !ctx.noRefs, colors, c: true, sel, mark, w: wroteRow(f, hi, ri) });
        continue;
      }
      // The change's mark: on its row in the lens, or on its first row drawn here.
      const want = tickRow(b), first = want >= start && want < end ? ri === want : !placed.has(b.id);
      placed.add(b.id);
      out += uRow(f, meta, text, ranges, {
        cls: (t === '+' ? 'add' : 'del') + (d ? ' rvd' : '') + other + (lensOut(f, hi, ri) ? ' lens-out' : ''), emphasis, refs: !ctx.noRefs, colors, c: true, sel, mark, w: wroteRow(f, hi, ri),
        tick: first ? tickHtml(b) : '', toggle: first && d ? diffToggle(b) : '',
        badges: ctx.noBadges ? '' : badgesHtml(f, b, ri, t !== '-' ? meta.n : null),
      });
    }
    return out;
  }
  // Split layout: removed lines on the left, added lines on the right, paired per change.
  function sCell(f, meta, text, ranges, side, o) {
    if (!meta) return `<span class="half ${side} empty"></span>`;
    const n = side === 'r' ? meta.n : null;
    const num = side === 'l' ? meta.o : meta.n;
    const sign = o.sign != null ? o.sign : side === 'l' && meta.t === '-' ? '−' : side === 'r' && meta.t === '+' ? '+' : '';
    const oldNo = side === 'l' && meta.t === '-' ? meta.o : null;
    const c = o.c && num != null ? ` data-c="${side === 'l' ? 'L' : 'R'}:${num}"` : '';
    const notes = side === 'r' ? (o.badges || '') + (o.toggle || '') : '';
    return `<span class="half ${side} ${o.cls || ''}${f.lang === 'md' ? ' md' : ''}"${c}${o.w >= 0 ? ` data-w="${o.w}"` : ''}><span class="no">${num != null ? num : ''}</span><span class="sg">${sign}</span><span class="tx">${codeHtml(f, text, ranges, { emphasis: o.emphasis, n, o: oldNo, refs: (side === 'r' && o.refs) || (oldNo != null && o.refs !== false), colors: o.colors })}</span>${notes ? `<span class="bdgs">${notes}</span>` : ''}</span>`;
  }
  function splitRowsHtml(f, hi, start, end, ctx) {
    ctx = ctx || {};
    const h = f.hunks[hi];
    let out = '';
    let ri = start;
    while (ri < end) {
      const meta = h.meta[ri];
      const b = meta.block;
      if (b && (b.move || b.movedTo)) {
        out += b.move ? movedHtml(f, b, ctx) : movedAwayHtml(b);
        while (ri < end && h.meta[ri].block === b) { if (b.movedTo) out += threadsAt(f, 'LEFT', h.meta[ri].o); ri++; }
        continue;
      }
      if (!b || !b.edits.length) {
        const [, text] = h.rows[ri];
        const colors = rowColors(h.rows, f.p, ri);
        out += `<div class="sl${inCompose(f, hi, ri) ? ' cm-sel' : ''}${markAt(f, hi, ri)}" data-n="${meta.n != null ? meta.n : ''}"><span class="g"></span>${sCell(f, meta, text, null, 'l', { cls: 'ctx', colors, c: true })}${sCell(f, meta, text, null, 'r', { cls: 'ctx', refs: !ctx.noRefs, colors, c: true })}</div>` + (meta.n != null ? peekAfter(f, meta.n) : '') + threadsAt(f, 'LEFT', meta.o) + threadsAt(f, 'RIGHT', meta.n);
        ri++;
        continue;
      }
      let bEnd = ri;
      while (bEnd < end && h.meta[bEnd].block === b) bEnd++;
      const dels = [], adds = [];
      for (let i = ri; i < bEnd; i++) (h.meta[i].t === '-' ? dels : adds).push(i);
      const d = done(b);
      const showDiff = !d || state.showReviewedDiff || state.blockDiff.has(b.id);
      const other = (ctx.unit && b.unit !== ctx.unit) || (ctx.chain && !ctx.chain.blockSet.has(b.id)) ? ' other' : '';
      const emphasis = b.adds > 0 && b.dels > 0;
      if (!showDiff) {
        if (!adds.length) {
          out += `<div class="sl gone"><span class="g">${tickHtml(b)}</span><span class="half l"><span class="tx">${b.dels} removed line${b.dels > 1 ? 's' : ''}, reviewed</span></span><span class="half r"><span class="bdgs">${diffToggle(b)}</span></span></div>`;
        }
        dels.forEach((i) => { out += threadsAt(f, 'LEFT', h.meta[i].o); });
        const want = tickRow(b, true), kWant = Math.max(0, adds.indexOf(want));
        adds.forEach((i, k) => {
          const m2 = h.meta[i];
          const colors = rowColors(h.rows, f.p, i);
          out += `<div class="sl rvd-quiet${other}${lensOut(f, hi, i) ? ' lens-out' : ''}${inCompose(f, hi, i) ? ' cm-sel' : ''}${markAt(f, hi, i)}" data-n="${m2.n}"><span class="g">${k === kWant ? tickHtml(b) : ''}</span>${sCell(f, m2, h.rows[i][1], null, 'l', { cls: 'ctx', sign: '', colors }).replace(/<span class="no">\d*<\/span>/, '<span class="no"></span>')}${sCell(f, m2, h.rows[i][1], null, 'r', { cls: 'ctx', sign: '', refs: !ctx.noRefs, toggle: k === 0 ? diffToggle(b) : '', colors, c: true, w: wroteRow(f, hi, i) })}</div>` + peekAfter(f, m2.n) + threadsAt(f, 'RIGHT', m2.n);
        });
      } else {
        const rows = Math.max(dels.length, adds.length);
        const outL = (i) => i != null && lensOut(f, hi, i);
        const want = tickRow(b);
        let kTick = 0;
        for (let k = 0; k < rows; k++) if (dels[k] === want || adds[k] === want) { kTick = k; break; }
        for (let k = 0; k < rows; k++) {
          const li = dels[k], ai = adds[k];
          const lm = li != null ? h.meta[li] : null, am = ai != null ? h.meta[ai] : null;
          const sel = (li != null && inCompose(f, hi, li)) || (ai != null && inCompose(f, hi, ai));
          const fade = lensOn() && (li == null || outL(li)) && (ai == null || outL(ai));
          out += `<div class="sl${d ? ' rvd' : ''}${other}${fade ? ' lens-out' : ''}${sel ? ' cm-sel' : ''}${markAt(f, hi, li, ai)}" data-n="${am ? am.n : ''}"><span class="g">${k === kTick ? tickHtml(b) : ''}</span>`
            + sCell(f, lm, lm ? h.rows[li][1] : '', lm ? h.rows[li][2] : null, 'l', { cls: 'del' + (outL(li) ? ' lens-out' : ''), emphasis, colors: li != null ? rowColors(h.rows, f.p, li) : null, c: true, w: li != null ? wroteRow(f, hi, li) : -1 })
            + sCell(f, am, am ? h.rows[ai][1] : '', am ? h.rows[ai][2] : null, 'r', { cls: 'add' + (outL(ai) ? ' lens-out' : ''), emphasis, refs: !ctx.noRefs, badges: am && !ctx.noBadges ? badgesHtml(f, b, ai, am.n) : '', toggle: k === kTick && d ? diffToggle(b) : '', colors: ai != null ? rowColors(h.rows, f.p, ai) : null, c: true, w: ai != null ? wroteRow(f, hi, ai) : -1 })
            + '</div>' + (am ? peekAfter(f, am.n) : '') + (lm ? peekAfterOld(f, lm.o) : '') + (lm ? threadsAt(f, 'LEFT', lm.o) : '') + (am ? threadsAt(f, 'RIGHT', am.n) : '');
        }
      }
      ri = bEnd;
    }
    return out;
  }
  const anyRowsHtml = (f, hi, s, e, ctx) => (sideBySide() ? splitRowsHtml(f, hi, s, e, ctx) : rowsHtml(f, hi, s, e, ctx));
  const BIG = 150;

  // ---------- more of the file
  // A file's diff is one stream of rows: the unchanged lines before the first hunk (a gap), the
  // hunk's rows, the next gap, and so on, then the unchanged lines after the last hunk. A view
  // shows sections of that stream (whole hunks, or the parts of them a chain needs). The band
  // above a section is its header, and stands for the lines hidden above it: clicking it shows
  // more of them, as GitHub's do. Gap lines come from the file at the head, which untangle sends
  // when they're first shown; a page saved on its own only grows within hunks.
  const MORE = 20;
  function hunkMeta(h) {
    if (!h.meta) {
      let o = h.o, n = h.n;
      h.meta = h.rows.map(([t]) => { const r = { t, o: t !== '+' ? o : null, n: t !== '-' ? n : null, block: null }; if (t !== '+') o++; if (t !== '-') n++; return r; });
    }
    return h.meta;
  }
  // The stream's pieces ({ gap, at, size, n, o } with the gap's first new and old line, or
  // { hi, at, size } for a hunk), and where the lines after the last hunk start.
  function streamOf(f) {
    if (f.stream) return f.stream;
    const segs = [];
    let at = 0, n = 1, o = 1;
    (f.hunks || []).forEach((h, hi) => {
      const meta = hunkMeta(h);
      const fn = meta.find((r) => r.n != null), fo = meta.find((r) => r.o != null);
      const gaps = [fn && fn.n - n, fo && fo.o - o].filter((x) => x != null);
      const size = f.s === 'M' && gaps.length ? Math.max(0, Math.min(...gaps)) : 0;
      if (size) segs.push({ gap: true, at, size, n, o });
      at += size;
      segs.push({ hi, at, size: h.rows.length });
      at += h.rows.length;
      meta.forEach((r) => { if (r.n != null) n = r.n + 1; if (r.o != null) o = r.o + 1; });
    });
    return (f.stream = { segs, at, n, o });
  }
  const segAt = (st, pos) => st.segs.find((g) => pos >= g.at && pos < g.at + g.size) || null;
  // Lines in the file at the head: untangle sends how many, or the file once it's loaded.
  function headLines(f) {
    if (CONFIG.lines && CONFIG.lines[f.p] != null) return CONFIG.lines[f.p];
    const s = sources.get(srcKey({ side: 'head', path: f.p }));
    return s && s.status === 'ok' ? s.count : null;
  }
  // The end of the stream, or null while the file's length is unknown.
  function streamEnd(f) {
    const st = streamOf(f);
    if (f.s !== 'M') return st.at;
    const total = headLines(f);
    return total == null ? null : st.at + Math.max(0, total - (st.n - 1));
  }
  // Unchanged lines from the file at the head: count of them (null: to its end) from new line n0, old line o0.
  function gapRowsHtml(f, n0, o0, count, ctx) {
    const s = CONFIG.served ? loadSource({ side: 'head', path: f.p }, true) : { status: 'error', error: 'These lines aren’t in this page.' };
    if (s.status !== 'ok') return `<div class="ln skip${s.status === 'loading' ? ' loading' : ''}"><span class="g"></span><span class="no"></span><span class="sg"></span><span class="tx">${s.status === 'loading' ? 'Loading lines…' : esc(s.error)}</span></div>`;
    if (count == null) count = Math.max(0, s.count - (n0 - 1));
    const colors = textColors(s.text, f.p);
    const split = sideBySide() && !ctx.unified;
    let h = '';
    for (let k = 0; k < count; k++) {
      const n = n0 + k, meta = { t: ' ', o: o0 + k, n }, text = s.lines[n - 1] != null ? s.lines[n - 1] : '', c = colors && colors[n - 1];
      h += split
        ? `<div class="sl" data-n="${n}"><span class="g"></span>${sCell(f, meta, text, null, 'l', { cls: 'ctx', colors: c })}${sCell(f, meta, text, null, 'r', { cls: 'ctx', refs: !ctx.noRefs, colors: c })}</div>` + peekAfter(f, n)
        : uRow(f, meta, text, null, { cls: 'ctx', refs: !ctx.noRefs, colors: c });
    }
    return h;
  }
  // Rows [a, b) of the stream (b may be Infinity: to the end of the file).
  function streamRowsHtml(f, a, b, ctx) {
    const st = streamOf(f), rows = ctx.rows || anyRowsHtml;
    let h = '';
    st.segs.forEach((g) => {
      const s = Math.max(a, g.at), e = Math.min(b, g.at + g.size);
      if (s < e) h += g.gap ? gapRowsHtml(f, g.n + s - g.at, g.o + s - g.at, e - s, ctx) : rows(f, g.hi, s - g.at, e - g.at, ctx);
    });
    if (b > st.at) {
      const s = Math.max(a, st.at);
      h += gapRowsHtml(f, st.n + s - st.at, st.o + s - st.at, b === Infinity ? null : b - s, ctx);
    }
    return h;
  }
  // The first old and new line numbers in rows [a, b).
  function numbersFrom(f, a, b) {
    const st = streamOf(f);
    let o = null, n = null;
    for (const g of st.segs) {
      if (g.at + g.size <= a || g.at >= b) continue;
      const i0 = Math.max(a, g.at) - g.at;
      if (g.gap) return { o: o != null ? o : g.o + i0, n: n != null ? n : g.n + i0 };
      const meta = f.hunks[g.hi].meta;
      for (let i = i0; i < Math.min(b, g.at + g.size) - g.at; i++) {
        if (o == null && meta[i].o != null) o = meta[i].o;
        if (n == null && meta[i].n != null) n = meta[i].n;
        if (o != null && n != null) return { o, n };
      }
    }
    return { o, n };
  }
  // How many of the hidden rows [from, to) can be shown going up from `to`, or down from `from`:
  // all of them when untangle serves the page, else those inside the hunk next to them.
  function canShow(f, from, to, dir) {
    if (to <= from) return 0;
    if (CONFIG.served) return to - from;
    const g = segAt(streamOf(f), dir === 'up' ? to - 1 : from);
    if (!g || g.gap) return 0;
    return dir === 'up' ? to - Math.max(from, g.at) : Math.min(to, g.at + g.size) - from;
  }
  // A section: rows [s0, e0) of hunk hi, at [a, b) in the stream.
  function sectionOf(f, hi, s0, e0, ctx) {
    const g = streamOf(f).segs.find((x) => x.hi === hi);
    return { key: (ctx.key || 'file') + '|' + f.p + '#' + hi + ':' + s0, hi, s0, e0, a: g.at + s0, b: g.at + e0 };
  }
  function sectionInfo(f, S, ctx) {
    const blocks = (f.blocks || []).filter((b) => b.hunk === S.hi && b.edits.length && b.first < S.e0 && b.first + b.len > S.s0
      && (!ctx.chain || ctx.chain.blockSet.has(b.id)) && (!ctx.unit || b.unit === ctx.unit));
    const allDone = blocks.length > 0 && blocks.every(done);
    const open = stats(blocks).open;
    // Reviewed sections fold, and so do long ones in a chain (new code aside), unless a
    // conversation is open in them.
    const folds = !!f.blocks;
    const threads = threadsIn(f, S.hi, S.s0, S.e0);
    const collapsed = folds && (state.collapsed.has(S.key) || ((allDone || (!!ctx.chain && !ctx.unit && !ctx.whole && S.e0 - S.s0 > BIG)) && !state.expanded.has(S.key) && !threads.open));
    return { S, blocks, open, allDone, folds, collapsed, threads };
  }
  const grown = (key) => state.more.get(key) || { above: 0, below: 0 };
  const moreAttrs = (key, side, n) => `data-act="more" data-key="${esc(key)}" data-side="${side}" data-n="${n}"`;
  const moreBtn = (key, side, n, ic, label, title) => `<button type="button" class="mo" ${moreAttrs(key, side, n)} title="${esc(title)}">${ic}${esc(label)}</button>`;
  const linesWord = (n) => `${fmt(n)} line${n === 1 ? '' : 's'}`;
  // The divider above section x: its first line and the hunk's context. The hidden rows [from, to)
  // sit between the rows shown below the section before it (P) and the rows shown above x: clicking
  // the divider shows more of them, as GitHub's bands do. Its buttons show under the pointer.
  function bandHtml(f, x, P, from, to, ctx) {
    const S = x.S, hk = f.hunks[S.hi];
    const hidden = to - from;
    const up = x.collapsed ? 0 : canShow(f, from, to, 'up');
    const down = P && !P.collapsed ? canShow(f, from, to, 'down') : 0;
    let btns = '', click = null;
    if (hidden <= MORE && (up === hidden || down === hidden) && hidden) {
      click = up === hidden ? [S.key, 'above', hidden] : [P.S.key, 'below', hidden];
      btns = moreBtn(...click, ICON.unfold, linesWord(hidden), `Show the ${linesWord(hidden)} hidden here`);
    } else {
      const dn = Math.min(MORE, down), un = Math.min(MORE, up);
      if (down) btns += moreBtn(P.S.key, 'below', dn, ICON.foldDown, linesWord(dn), `Show ${linesWord(dn)} more below the code above`);
      if (up) btns += moreBtn(S.key, 'above', un, ICON.foldUp, linesWord(un), `Show ${linesWord(un)} more above`);
      click = up ? [S.key, 'above', un] : down ? [P.S.key, 'below', dn] : null;
    }
    const { o, n } = numbersFrom(f, x.collapsed ? S.a : to, S.b);
    const head = S.s0 === 0 && to === S.a && hk.h ? hk.h : '';
    const tip = click ? (click[1] === 'above' ? `Show ${linesWord(click[2])} more above` : `Show ${linesWord(click[2])} more below the code above`) + (hidden > click[2] ? ` (${fmt(hidden)} hidden)` : '') : '';
    const unit = x.blocks.length && x.blocks.every((block) => block.unit && block.unit === x.blocks[0].unit) ? x.blocks[0].unit : null;
    let out = `<div class="hh${x.allDone ? ' done' : ''}${P && !hidden ? ' joined' : ''}${click ? ' more' : ''}" data-sec="${esc(S.key)}"${unit ? ` data-unit="${esc(unit)}"` : ''}${x.collapsed && x.open ? ` data-nav="1" data-open="${x.open}"` : ''}${click ? ` ${moreAttrs(...click)} title="${esc(tip)}"` : ''}>`
      + `<span class="hh-g">${x.folds ? `<button type="button" class="chev" data-act="toggle-hunk" data-key="${esc(S.key)}" aria-expanded="${!x.collapsed}" title="${x.collapsed ? 'Unfold' : 'Fold'}">${x.collapsed ? ICON.chevronRight : ICON.chevronDown}</button>` : ''}</span>`
      + `<span class="hh-at" title="@@ −${o != null ? o : hk.o} +${n != null ? n : hk.n} @@">${n != null ? n : hk.n}</span><span class="hh-tx">${esc(head)}</span>`;
    if (x.collapsed) {
      const lines = linesWord(S.e0 - S.s0);
      const count = (n, cls, title) => (n ? `<span class="cm-cnt${cls}" title="${title}">${ICON.comment}${n}</span>` : '');
      const threads = count(x.threads.threads, '', 'Threads on these lines') + count(x.threads.notes, ' note', 'Notes on these lines');
      out += x.allDone ? `<span class="hh-sum ok">${ICON.check}${lines} reviewed${threads}</span>` : `<span class="hh-sum">${lines}${x.open ? ` · ${x.open} to review` : ''}${threads}</span>`;
      const focus = ctx.chain && ctx.chain.focus ? x.blocks.flatMap((b) => ctx.chain.focus[b.id] || []) : [];
      if (focus.length && !x.allDone) out += `<span class="hh-chips"><span class="hh-sum">in this chain:</span>${[...new Set(focus)].slice(0, 8).map((ln) => `<button type="button" class="chip-btn" data-act="expand-to" data-key="${esc(S.key)}" data-line="${ln}">line ${ln}</button>`).join('')}</span>`;
    }
    out += `<span class="sp"></span><span class="hh-x">${btns}`;
    if (x.blocks.length && (!lensOn() || x.blocks.some(blockIn))) out += `<button type="button" class="btn xs" data-act="mark-blocks" data-blocks="${esc(x.blocks.map((b) => b.id).join(' '))}" title="${x.open ? 'Mark every change in this hunk reviewed (Shift+Space)' : 'Mark this hunk’s changes unreviewed'}">${x.open ? 'Mark hunk reviewed' : 'Mark hunk unreviewed'}</button>`;
    return out + '</span></div>';
  }
  // The divider after a file's last section, while lines follow it (rest: how many, null if unknown).
  function tailHtml(key, rest) {
    const n = rest == null ? MORE : Math.min(MORE, rest);
    const all = rest != null && rest <= MORE;
    const title = all ? `Show the last ${linesWord(rest)}` : `Show ${linesWord(n)} more`;
    return `<div class="hh hh-tail more" ${moreAttrs(key, 'below', n)} title="${esc(title)}"><span class="hh-g"></span><span class="hh-at"></span><span class="hh-tx">${rest == null ? 'More lines below' : `${linesWord(rest)} below`}</span><span class="sp"></span><span class="hh-x">${moreBtn(key, 'below', n, all ? ICON.unfold : ICON.foldDown, linesWord(n), title)}</span></div>`;
  }
  // A file's sections, sorted, with their bands and the rows shown around them.
  function sectionsHtml(f, secs, ctx) {
    const xs = secs.map((S) => sectionInfo(f, S, ctx));
    let h = '';
    xs.forEach((x, i) => {
      const P = i ? xs[i - 1] : null, S = x.S;
      const from = !P ? 0 : P.collapsed ? P.S.b : Math.min(P.S.b + grown(P.S.key).below, S.a);
      const to = x.collapsed ? S.a : Math.max(S.a - grown(S.key).above, from);
      if (P && from > P.S.b) h += streamRowsHtml(f, P.S.b, from, ctx);
      h += bandHtml(f, x, P, from, to, ctx);
      if (!x.collapsed) h += streamRowsHtml(f, to, S.b, ctx);
    });
    const L = xs[xs.length - 1];
    if (L && !L.collapsed) {
      const end = streamEnd(f), want = L.S.b + grown(L.S.key).below;
      const stop = end == null ? want : Math.min(want, end);
      if (stop > L.S.b) h += streamRowsHtml(f, L.S.b, stop, ctx);
      const rest = end == null ? null : end - stop;
      if (CONFIG.served && (rest == null ? f.s === 'M' : rest > 0)) h += tailHtml(L.S.key, rest);
    }
    return h;
  }
  // The whole file: every hunk and every line between them.
  function wholeHtml(f, ctx) {
    const end = streamEnd(f);
    return streamRowsHtml(f, 0, end == null ? Infinity : end, ctx);
  }
  // The hunks a set of changes needs: each change with 3 lines of context, merged when they touch.
  // ctx.tight: only unchanged lines around the blocks, so the changes next to them don't read as
  // theirs.
  function subHunksHtml(blocks, ctx) {
    const byFile = new Map();
    blocks.forEach((b) => { if (!byFile.has(b.file)) byFile.set(b.file, []); byFile.get(b.file).push(b); });
    let h = '';
    [...byFile.keys()].sort((x, y) => x.idx - y.idx).forEach((f) => {
      h += `<div class="sec-file"><button type="button" class="linkish" data-open="${esc(f.p)}">${pathHtml(f.p)}</button></div><div class="code" data-p="${esc(f.p)}">`;
      const byHunk = new Map();
      byFile.get(f).forEach((b) => { if (!byHunk.has(b.hunk)) byHunk.set(b.hunk, []); byHunk.get(b.hunk).push(b); });
      const secs = [];
      [...byHunk.keys()].sort((x, y) => x - y).forEach((hi) => {
        const hr = f.hunks[hi].rows, rows = hr.length;
        const around = (b) => {
          let s = Math.max(0, b.first - 3), e = Math.min(rows, b.first + b.len + 3);
          if (ctx.tight) {
            while (s < b.first && hr.slice(s, b.first).some((r) => r[0] !== ' ')) s++;
            while (e > b.first + b.len && hr.slice(b.first + b.len, e).some((r) => r[0] !== ' ')) e--;
          }
          return [s, e];
        };
        const ranges = byHunk.get(hi).map(around).sort((x, y) => x[0] - y[0]);
        const merged = [];
        ranges.forEach((r) => { const last = merged[merged.length - 1]; if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push(r.slice()); });
        merged.forEach(([s0, e0]) => secs.push(sectionOf(f, hi, s0, e0, ctx)));
      });
      h += sectionsHtml(f, secs, ctx) + '</div>';
    });
    return h;
  }

  // ---------- peek
  // The open peek: not one folding away as it closes, a picture of it left in the page for a moment.
  const PEEK = '.peek:not(.ghost .peek)';
  // The top panel shows the definition, or the changed usage picked in the list below it.
  // Clicking a usage once shows it here; clicking it again (or "Go to it") opens it.
  function usageContextHtml(hl) {
    const h = hl.f.hunks[hl.hi];
    const rows = [];
    for (let i = 0; i < h.rows.length; i++) if (h.meta[i].n != null) rows.push(i);
    const at = rows.indexOf(hl.ri);
    return rows.slice(Math.max(0, at - 4), at + 5).map((i) => {
      const r = h.meta[i];
      return `<div class="pk-ln${i === hl.ri ? ' hit' : ''}${r.t === '+' ? ' add' : ''}"><span class="no">${r.n}</span><span class="sg">${r.t === '+' ? '+' : ''}</span><span class="tx">${codeHtml(hl.f, h.rows[i][1], null, { colors: rowColors(h.rows, hl.f.p, i), live: CONFIG.served ? { side: 'head', p: hl.f.p, line: r.n } : null })}</span></div>`;
    }).join('');
  }
  // Every peek uses the same bounded code viewport. Served reviews fill it with the whole
  // file, keeping the saved snippet useful while the file (or an external path) is loading.
  function peekCodeHtml(t, fallback, usage) {
    const v = { side: t.side, path: t.p, ext: t.ext, commit: t.commit };
    const canLoad = CONFIG.served && (t.side || t.ext != null || t.commit);
    const source = canLoad ? loadSource(v, 'peek') : null;
    const full = source && source.status === 'ok';
    const lines = full ? source.lines : t.code || [];
    const waiting = source && source.status === 'loading';
    if (waiting && !fallback && !lines.length) return PEEK_WAIT;
    const start = full ? 1 : t.s || 1;
    const key = `${srcKey(v)}:${t.l}:${full ? 'file' : 'snippet'}`;
    const colors = textColors(full ? source.text : lines.join('\n'), t.p);
    const file = { p: t.p, lang: C.langOf(t.p) };
    const body = !full && fallback ? fallback : lines.map((text, i) => {
      const ln = start + i;
      const row = usage && M().head.get(t.p + ':' + ln);
      const added = row && row.r.t === '+';
      const live = canLoad && !t.commit ? { side: t.side, p: t.side ? t.p : null, ext: t.ext, line: ln } : null;
      const moved = t.mark && ln >= t.mark[0] && ln <= t.mark[1];
      return `<div class="pk-ln${file.lang === 'md' ? ' md' : ''}${ln === t.l ? ' hit' : ''}${added ? ' add' : ''}${moved ? ' mvr' : ''}" data-n="${ln}"><span class="no">${ln}</span>${usage ? `<span class="sg">${added ? '+' : ''}</span>` : ''}<span class="tx">${codeHtml(file, text, null, { colors: colors && colors[i], live })}</span></div>`;
    }).join('');
    const note = source && source.status === 'error' ? `<div class="pk-foot">${esc(source.error)} · showing the saved snippet</div>` : '';
    // While the whole file is on its way, the saved lines show in a viewport as tall as it will be.
    return `<div class="pk-code${waiting ? ' pk-tall' : ''}" tabindex="0" aria-label="Code in ${esc(t.p)}" data-peek-code="${esc(key)}">${body}</div>${note}`;
  }
  // The code viewport while what it shows is on its way: as tall as the code will be, so a peek
  // opens once, to its height, and fills in place.
  const PEEK_WAIT = `<div class="pk-code pk-wait" aria-busy="true" aria-label="Looking it up">${'<i class="pk-sk"></i>'.repeat(14)}</div>`;
  // The open peek, drawn again in place (an answer or a file arrived): only it changes, and its
  // height eases to what it holds now.
  function updatePeek() {
    const el = main.querySelector(PEEK);
    if (!el || !state.peek) return render();
    savePeekScroll();
    const h0 = el.getBoundingClientRect().height;
    const tmp = document.createElement('div');
    tmp.innerHTML = peekHtml(state.peek);
    el.replaceChildren(...tmp.firstElementChild.childNodes);
    restorePeekScroll();
    shownPeek = state.peek;
    // Still opening: it carries on to its height from where it got to.
    el.getAnimations().forEach((a) => a.finish());
    const h1 = el.getBoundingClientRect().height;
    if (moving() && Math.abs(h1 - h0) > 3) unanchored(el.animate([{ height: h0 + 'px' }, { height: h1 + 'px' }], { duration: 200, easing: EASE }));
    mini.update();
  }
  function cachedPeekTarget(p, t, side) {
    if (side) return { ...t, side };
    if (p.resolved) return { ...t, ...p.resolved };
    if (CONFIG.served && !p.resolving) {
      p.resolving = true;
      askDefinition({ side: p.old ? 'base' : 'head', p: p.path, l: p.old ? p.o : p.n, c: p.col }).then((live) => {
        if (live.status !== 'ok') return;
        p.resolved = live.target;
        if (state.peek === p) updatePeek();
      });
    }
    return t;
  }
  // Keep each definition/usage's position across redraws and Back. A new file starts at
  // the requested line, with a little context above; scrolling stays inside the window.
  function savePeekScroll() {
    const code = main.querySelector(PEEK + ' .pk-code');
    if (!code || !state.peek) return;
    if (!state.peek.scrolls) state.peek.scrolls = new Map();
    state.peek.scrolls.set(code.dataset.peekCode, [code.scrollLeft, code.scrollTop]);
  }
  function restorePeekScroll() {
    const code = main.querySelector(PEEK + ' .pk-code');
    if (!code || !state.peek) return;
    const at = state.peek.scrolls && state.peek.scrolls.get(code.dataset.peekCode);
    if (at) { code.scrollLeft = at[0]; code.scrollTop = at[1]; return; }
    const hit = code.querySelector('.hit');
    if (hit) code.scrollTop = hit.getBoundingClientRect().top - code.getBoundingClientRect().top - Math.min(80, code.clientHeight / 3);
  }
  main.addEventListener('scroll', (e) => { if (e.target.matches && e.target.matches('.pk-code')) savePeekScroll(); }, true);

  const placeWords = (t) => (t.side === 'base' ? `old side · ${(CONFIG.base || '').slice(0, 7)}` : t.side === 'head' ? 'this repo' : t.w === 'sdk' ? 'Dart SDK' : t.w === 'package' ? 'package' : 'outside the repo');
  const peekBack = (p) => (p.back && p.back.length ? '<button type="button" class="btn xs" data-act="peek-back">Back</button>' : '');
  // A definition asked live, with the same code viewport and navigation as a saved one.
  function livePeekHtml(p) {
    const L = p.live;
    const back = peekBack(p);
    const close = '<button type="button" class="pk-x" data-act="close-peek">Close</button>';
    if (L.status === 'loading') return `<div class="pk-h"><b>Definition</b><span class="pk-src">looking it up…</span><span class="sp"></span>${back}${close}</div>${PEEK_WAIT}`;
    if (L.status !== 'ok') return `<div class="pk-h"><b>Definition</b><span class="pk-loc">${esc(L.error || 'The language server knows no definition for this name.')}</span><span class="sp"></span>${back}${close}</div>`;
    const t = L.target;
    const where = placeWords(t);
    let h = `<div class="pk-h"><b>Definition</b><span class="pk-loc">${esc(t.p)}:${t.l}</span><span class="pk-src">${where}</span><span class="sp"></span>${back}${implButton(p)}`
      + sourceButton({ side: t.side, p: t.side ? t.p : null, ext: t.ext, line: t.l, label: t.w !== 'repo' ? t.p : null, where }, 'Open file', 'btn xs')
      + editorHtml({ side: t.side, p: t.p, abs: t.abs, line: t.l, col: t.c }) + close + '</div>'
      + peekCodeHtml(t);
    if (t.side === 'head' && M().head.has(t.p + ':' + t.l)) h += `<div class="pk-foot"><button type="button" class="linkish" data-open="${esc(t.p)}" data-line="${t.l}">Go to it in this diff</button></div>`;
    return h;
  }
  // The lines that use a name, asked live where it's declared, or the declarations that implement
  // it: as with changed usages, the one picked shows above the list.
  const USES_WAIT = `<div class="pk-wait pk-few" aria-busy="true" aria-label="Looking them up">${'<i class="pk-sk"></i>'.repeat(4)}</div>`;
  const LIST_WORDS = { usages: ['Usage', 'usage'], implementations: ['Implementation', 'implementation'] };
  // The way from a peek to what implements its name, where it can have implementations.
  const implButton = (p) => (CONFIG.served && peekSubject(p) ? '<button type="button" class="btn xs" data-act="peek-impl" title="What extends, implements or overrides it, from the language server">Implementations</button>' : '');
  function usesPeekHtml(p) {
    const U = p.uses;
    const [One, one] = LIST_WORDS[U.kind];
    const back = peekBack(p);
    const close = '<button type="button" class="pk-x" data-act="close-peek">Close</button>';
    const name = `<span class="pk-loc">${esc(U.name)}</span>`;
    if (U.status === 'loading') return `<div class="pk-h"><b>${One}s</b>${name}<span class="pk-src">looking them up…</span><span class="sp"></span>${back}${close}</div>${USES_WAIT}`;
    if (U.status !== 'ok') return `<div class="pk-h"><b>${One}s</b><span class="pk-loc">${esc(U.error)}</span><span class="sp"></span>${back}${close}</div>`;
    const n = U.list.length;
    const scope = 'in the packages this review changes';
    if (!n) return `<div class="pk-h"><b>No ${one}s</b>${name}<span class="pk-src">${scope}</span><span class="sp"></span>${back}${implButton(p)}${close}</div>`;
    const sel = p.sel != null ? U.list[p.sel] : null;
    let h = '';
    if (sel) {
      h += `<div class="pk-h"><b>${One} ${p.sel + 1} of ${n}</b><span class="pk-loc">${esc(sel.p)}:${sel.l}</span><span class="pk-src">${placeWords(sel)}</span><span class="sp"></span>${back}`
        + `<button type="button" class="btn xs primary" data-act="peek-go">Go to it</button>${close}</div>`
        + peekCodeHtml({ side: sel.side, p: sel.p, ext: sel.ext, l: sel.l, s: sel.l, code: [sel.text] }, null, sel.side === 'head');
    }
    h += `<div class="pk-h${sel ? ' pk-h2' : ''}"><b>${U.truncated ? 'The first ' : ''}${n} ${one}${n === 1 ? '' : 's'}</b>${name}<span class="pk-src">${scope}</span><span class="pk-hint">Click one to show it above, again to go to it</span><span class="sp"></span>${sel ? implButton(p) : back + implButton(p) + close}</div><div class="pk-list">`;
    const names = shortNames(U.list.map((u) => u.p));
    U.list.forEach((u, i) => {
      h += `<button type="button" class="pk-use" data-act="peek-use" data-i="${i}" aria-current="${p.sel === i}" title="${p.sel === i ? 'Go to it' : 'Show it above'}"><span class="pk-up">${esc(names.get(u.p))}:${u.l}</span><code>${u.in ? `<span class="pk-in">${esc(u.in)}</span>` : ''}${codeHtml({ p: u.p, lang: C.langOf(u.p) }, u.text.trim(), null, {})}</code></button>`;
    });
    return h + '</div>';
  }
  // Each path as its file's name, with as many of its folders as tell it from the others there.
  function shortNames(paths) {
    const all = [...new Set(paths)].map((p) => p.split('/'));
    const tail = (parts, k) => parts.slice(-k).join('/');
    return new Map(all.map((parts) => {
      let k = 1;
      while (k < parts.length && all.some((o) => o !== parts && tail(o, k) === tail(parts, k))) k++;
      return [parts.join('/'), tail(parts, k)];
    }));
  }
  // A test file's outline under one commit: the changes in it that commit started, as its chain
  // holds them. None when the file isn't a test or nothing the commit started is left.
  function commitTests(sha, path) {
    const m = M(), ci = hxOn() ? HX.index.get(sha) : null;
    const f = ci == null ? null : m.files.find((x) => x.p === path);
    if (!f || !olOf(f) || !TEST_FILE.test(f.p)) return null;
    // By commit, a change is in the chain of the commit that started it; else, its first line tells.
    const started = (b) => {
      if (m.byCommit) return (m.chainsOf.get(b.id) || []).some((id) => chainSha(m.chains[id]) === sha);
      const h = b.file.hunks[b.hunk];
      for (let ri = b.first; ri < b.first + b.len; ri++) if (h.rows[ri][0] !== ' ') return rowCommit(b.file, b.hunk, ri) === ci;
      return false;
    };
    const blocks = f.blocks.filter((b) => b.edits.length && started(b));
    return blocks.length ? olScope(f, { id: 'c' + sha, sha, blockSet: new Set(blocks.map((b) => b.id)) }) : null;
  }
  // A commit's file in History: a test file reads as its outline, as in a chain, with its diff a
  // click away; any other file as its diff.
  function historyPeekHtml(p) {
    const v = p.history;
    const sc = commitTests(v.sha, v.path);
    const to = (mode, label) => `<button type="button" class="btn xs" data-act="hd-peek" data-mode="${mode}">${label}</button>`;
    if (sc && !v.diff) {
      return `<div class="pk-h"><b>Tests</b><span class="pk-loc">${esc(v.path)}</span><span class="pk-src">Commit ${shortSha(v.sha)}</span><span class="sp"></span>${to('diff', 'Diff')}<button type="button" class="pk-x" data-act="close-peek">Close</button></div>`
        + `<div class="pk-ol">${olFileHtml(sc)}</div>`;
    }
    const s = CONFIG.served ? loadSource({ commit: v.sha, path: v.path }, true) : { status: 'error', error: 'This saved page does not contain files at earlier commits. Open the served review to read them.' };
    const head = `<div class="pk-h"><b>Diff</b><span class="pk-loc">${esc(v.path)}</span><span class="pk-src">Commit ${shortSha(v.sha)}</span><span class="sp"></span>${sc ? to('tests', 'Tests') : ''}<button type="button" class="pk-x" data-act="close-peek">Close</button></div>`;
    if (s.status !== 'ok') return head + `<div class="pk-foot">${s.status === 'loading' ? 'Loading the diff…' : esc(s.error)}</div>`;
    const file = { p: v.path, lang: C.langOf(v.path) };
    let first = true;
    const body = s.hunks.map((h) => {
      let old = h.o, next = h.n;
      const rows = h.l.map((line) => [line[0], line.slice(1)]);
      return `<div class="pk-hunk">@@ −${h.o} +${h.n} @@ ${esc(h.h)}</div>` + rows.map(([type, text], i) => {
        const o = type === '+' ? null : old++;
        const n = type === '-' ? null : next++;
        const hit = first && type !== ' ';
        if (hit) first = false;
        return `<div class="pk-ln${type === '+' ? ' add' : type === '-' ? ' del' : ''}${file.lang === 'md' ? ' md' : ''}${hit ? ' hit' : ''}" data-o="${o ?? ''}" data-n="${n ?? ''}"><span class="no">${o ?? ''}</span><span class="no">${n ?? ''}</span><span class="sg">${type === '-' ? '−' : type === '+' ? '+' : ''}</span><span class="tx">${codeHtml(file, text, null, { colors: rowColors(rows, v.path, i) })}</span></div>`;
      }).join('');
    }).join('');
    const note = s.from ? `Renamed from ${s.from}` : s.binary ? 'Binary file changed' : s.change === 'A' ? 'Empty file added' : s.change === 'D' ? 'Empty file deleted' : 'File metadata changed';
    const code = (s.from || !body ? `<div class="pk-foot">${esc(note)}</div>` : '')
      + (body ? `<div class="pk-code" tabindex="0" aria-label="Diff in ${esc(v.path)}" data-peek-code="commit:${v.sha}:${esc(v.path)}:diff">${body}</div>` : '');
    const current = M().files.some((f) => f.p === v.path) || M().generated.some((f) => f.p === v.path);
    return head + code + (current ? `<div class="pk-foot"><button type="button" class="linkish" data-open="${esc(v.path)}">Go to it in this review</button></div>` : '');
  }
  function peekHtml(p) {
    if (p.history) return '<div class="peek" role="region" aria-label="Peek">' + historyPeekHtml(p) + '</div>';
    if (p.ext) return '<div class="peek" role="region" aria-label="Peek">' + extPeekHtml(p) + '</div>';
    if (p.uses) return '<div class="peek" role="region" aria-label="Peek">' + usesPeekHtml(p) + '</div>';
    if (p.live) return '<div class="peek" role="region" aria-label="Peek">' + livePeekHtml(p) + '</div>';
    if (p.moveOf) return '<div class="peek" role="region" aria-label="Peek">' + movePeekHtml(p) + '</div>';
    let h = '<div class="peek" role="region" aria-label="Peek">';
    const hasDef = p.ti !== undefined && p.ti !== null && !Number.isNaN(p.ti);
    const list = p.usageKey ? REFS[state.compare][p.usageKey] || [] : [];
    const isOpen = ([up, ul]) => { const hl = M().head.get(up + ':' + ul); return hl && hl.r.block && !done(hl.r.block); };
    const sel = p.sel != null && list[p.sel] ? list[p.sel] : null;
    const selHl = sel && M().head.get(sel[0] + ':' + sel[1]);
    if (sel && selHl) {
      h += `<div class="pk-h"><b>Usage ${p.sel + 1} of ${list.length}</b><span class="pk-loc">${esc(sel[0])}:${sel[1]}</span><span class="pk-src">${isOpen(sel) ? 'not reviewed' : 'reviewed'}</span><span class="sp"></span>`
        + (hasDef ? '<button type="button" class="btn xs" data-act="peek-def">Back to definition</button>' : '')
        + `<button type="button" class="btn xs primary" data-act="peek-go">Go to it</button><button type="button" class="pk-x" data-act="close-peek">Close</button></div>`
        + peekCodeHtml({ p: sel[0], side: 'head', l: sel[1] }, usageContextHtml(selHl), true);
    } else if (hasDef) {
      const t = p.old ? DEFS_OLD[state.compare].targets[p.ti] : defsNow().targets[p.ti];
      const where = (p.old ? `old side · ${M().raw.left} · ` : '') + (t.w === 'repo' ? 'this repo' : t.w === 'sdk' ? 'Dart SDK' : 'package');
      const side = t.w === 'repo' ? (p.old ? 'base' : 'head') : null;
      h += `<div class="pk-h"><b>Definition</b><span class="pk-loc">${esc(t.p)}:${t.l}</span><span class="pk-src">${where}</span><span class="sp"></span>${implButton(p)}`
        + (side ? sourceButton({ side, p: t.p, line: t.l }, 'Open file', 'btn xs') + editorHtml({ side, p: t.p, line: t.l }) : CONFIG.served ? '<button type="button" class="btn xs" data-act="open-def">Open file</button>' : '')
        + `<button type="button" class="pk-x" data-act="close-peek">Close</button></div>`
        + peekCodeHtml(cachedPeekTarget(p, t, side));
      if (!p.old && t.w === 'repo' && M().head.has(t.p + ':' + t.l) && !(t.p === p.path && t.l === p.n)) {
        h += `<div class="pk-foot"><button type="button" class="linkish" data-open="${esc(t.p)}" data-line="${t.l}">Go to it in this diff</button></div>`;
      }
    }
    if (p.usageKey) {
      const open = list.filter(isOpen).length;
      h += `<div class="pk-h pk-h2"><b>${list.length} changed usage${list.length === 1 ? '' : 's'}</b><span class="pk-src">${open} not reviewed</span><span class="pk-hint">Click one to show it above, again to go to it</span><span class="sp"></span>
        <button type="button" class="btn xs" data-act="mark-usages" data-usage="${esc(p.usageKey)}">${open ? 'Mark them reviewed' : 'Mark them unreviewed'}</button></div><div class="pk-list">`;
      list.forEach((u, i) => {
        const [up, ul] = u;
        const hl = M().head.get(up + ':' + ul);
        const text = hl ? hl.f.hunks[hl.hi].rows[hl.ri][1].trim() : '';
        h += `<button type="button" class="pk-use${isOpen(u) ? '' : ' done'}" data-act="peek-use" data-i="${i}" aria-current="${p.sel === i}" title="${p.sel === i ? 'Go to it' : 'Show it above'}"><span class="pk-up">${esc(fileName(up))}:${ul}</span><code>${hl ? codeHtml(hl.f, text, null, {}) : ''}</code></button>`;
      });
      h += '</div>';
    }
    return h + '</div>';
  }
  // Re-render only the peek, keeping the page and the usage list where they were.
  function refreshPeek(from, focusSel) {
    const el = from.closest('.peek');
    if (!el) return render();
    const listTop = el.querySelector('.pk-list') ? el.querySelector('.pk-list').scrollTop : 0;
    const tmp = document.createElement('div');
    tmp.innerHTML = peekHtml(state.peek);
    const next = tmp.firstElementChild;
    el.replaceWith(next);
    restorePeekScroll();
    const lst = next.querySelector('.pk-list');
    if (lst) lst.scrollTop = listTop;
    const f = next.querySelector(focusSel);
    if (f) f.focus();
  }

  // ---------- graphs
  const NW = 214, NH = 52, GX = 66, GY = 14, PAD = 16;
  // spec: { id, nodes: [{ key, layer, l1, l2, cnt, ok, root, grp, attr, tip, label }], edges: [{ from, to, labels }], focus, w }
  function layeredSvg(spec) {
    const W0 = spec.w || NW;
    const layers = new Map();
    spec.nodes.forEach((n) => { if (!layers.has(n.layer)) layers.set(n.layer, []); layers.get(n.layer).push(n); });
    const keys = [...layers.keys()].sort((a, b) => a - b);
    const posOf = new Map();
    const more = [];
    let maxRows = 1;
    keys.forEach((L, li) => {
      let list = layers.get(L);
      let hidden = 0;
      const cap = spec.cap || 7;
      if (list.length > cap && !state.graphOpen.has(spec.id + ':' + L)) { hidden = list.length - (cap - 1); list = list.slice(0, cap - 1); }
      list.forEach((n, ri) => posOf.set(n.key, { x: PAD + li * (W0 + GX), y: PAD + ri * (NH + GY), n }));
      if (hidden) more.push({ x: PAD + li * (W0 + GX), y: PAD + list.length * (NH + GY), hidden, L });
      maxRows = Math.max(maxRows, list.length + (hidden ? 1 : 0));
    });
    const W = PAD * 2 + keys.length * W0 + Math.max(0, keys.length - 1) * GX + 40;
    const H = PAD * 2 + maxRows * NH + (maxRows - 1) * GY;
    const near = new Set();
    if (spec.focus) { near.add(spec.focus); spec.edges.forEach((e) => { if (e.from === spec.focus) near.add(e.to); if (e.to === spec.focus) near.add(e.from); }); }
    let svg = `<svg class="graph" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(spec.label)}">
      <defs><marker id="gar-${spec.marker || spec.id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker></defs>`;
    let labels = '';
    const ports = new Map();
    const port = (key, side, otherY) => { const k = key + side; if (!ports.has(k)) ports.set(k, []); ports.get(k).push(otherY); };
    const visible = spec.edges.filter((e) => posOf.get(e.from) && posOf.get(e.to));
    visible.forEach((e) => {
      const a = posOf.get(e.from), b = posOf.get(e.to);
      const fwd = a.x < b.x, same = a.x === b.x;
      port(e.from, same || fwd ? 'R' : 'L', b.y); port(e.to, same || !fwd ? 'R' : 'L', a.y);
    });
    ports.forEach((list) => list.sort((x, y) => x - y));
    const portY = (key, side, otherY, base) => {
      const list = ports.get(key + side);
      if (!list || list.length < 2) return base + NH / 2;
      return base + 10 + (list.indexOf(otherY) * (NH - 20)) / (list.length - 1);
    };
    // A name goes on its arrow's middle when it fits there between the members; else where the
    // arrow crosses a gap between rows of members, the free one nearest its middle; else in the gap
    // nearest its middle. It covers no member.
    const gaps = Array.from({ length: maxRows + 1 }, (_, r) => (r === 0 ? PAD / 2 : r === maxRows ? H - PAD / 2 : PAD + r * (NH + GY) - GY / 2));
    const boxes = [...posOf.values(), ...more];
    const taken = [];
    const placeName = (c, text) => {
      const w = text.length * 6.3 + 8;
      const pt = (t) => { const u = 1 - t; return [u * u * u * c[0] + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6], u * u * u * c[1] + 3 * u * u * t * c[3] + 3 * u * t * t * c[5] + t * t * t * c[7]]; };
      const mid = pt(0.5);
      const spots = [{ x: mid[0], y: mid[1], far: -1 }];
      let p = pt(0);
      for (let k = 1; k <= 32; k++) {
        const q = pt(k / 32);
        gaps.forEach((gy) => { if (p[1] !== q[1] && (p[1] - gy) * (q[1] - gy) <= 0) spots.push({ x: p[0] + ((gy - p[1]) / (q[1] - p[1])) * (q[0] - p[0]), y: gy, far: Math.abs(k / 32 - 0.5) }); });
        p = q;
      }
      if (spots.length === 1) gaps.forEach((gy) => spots.push({ x: mid[0], y: gy, far: 1 + Math.abs(gy - mid[1]) / H }));
      spots.sort((s1, s2) => s1.far - s2.far);
      const box = (sp) => { const x = Math.max(w / 2 + 2, Math.min(W - w / 2 - 2, sp.x)); return { x, y: sp.y, l: x - w / 2, r: x + w / 2 }; };
      const clear = (bx) => !boxes.some((o) => o.x < bx.r && bx.l < o.x + W0 && o.y < bx.y + 7 && bx.y - 7 < o.y + NH);
      const free = (bx) => !taken.some((o) => o.l < bx.r && bx.l < o.r && Math.abs(o.y - bx.y) < 14);
      const all = spots.map(box);
      const at = all.find((bx) => clear(bx) && free(bx)) || all.find(clear) || all[0];
      taken.push(at);
      return at;
    };
    const shown = new Set();
    visible.forEach((e) => {
      const a = posOf.get(e.from), b = posOf.get(e.to);
      const fwd0 = a.x < b.x, same0 = a.x === b.x;
      const y1 = portY(e.from, same0 || fwd0 ? 'R' : 'L', b.y, a.y), y2 = portY(e.to, same0 || !fwd0 ? 'R' : 'L', a.y, b.y);
      // The curve's points: start, two controls, end.
      let c;
      if (a.x !== b.x) {
        const x1 = fwd0 ? a.x + W0 : a.x, x2 = fwd0 ? b.x - 3 : b.x + W0 + 3;
        const mx = (x1 + x2) / 2;
        c = [x1, y1, mx, y1, mx, y2, x2, y2];
      } else {
        const x1 = a.x + W0, x2 = b.x + W0 + 3, bx = x1 + 30;
        c = [x1, y1, bx, y1, bx, y2, x2, y2];
      }
      const dim = spec.focus && !(e.from === spec.focus || e.to === spec.focus);
      const long = spec.faintLong && Math.abs(a.n.layer - b.n.layer) > 1;
      svg += `<path class="g-edge${dim ? ' dim' : ''}${long ? ' long' : ''}${e.share ? ' share' : ''}" d="M${c[0]} ${c[1]} C ${c[2]} ${c[3]}, ${c[4]} ${c[5]}, ${c[6]} ${c[7]}"${e.share ? '' : ` marker-end="url(#gar-${spec.marker || spec.id})"`}/>`;
      // What an arrow uses is named only on the arrows of the member clicked.
      if (e.labels && e.labels.length && spec.focus && !dim) {
        const text = trunc(e.labels[0], 18) + (e.labels.length > 1 ? ' +' + (e.labels.length - 1) : '');
        if (!shown.has(e.to + '|' + text)) {
          shown.add(e.to + '|' + text);
          const at = placeName(c, text);
          labels += `<text class="g-elabel" x="${at.x.toFixed(1)}" y="${(at.y + 3.5).toFixed(1)}" text-anchor="middle">${esc(text)}</text>`;
        }
      }
    });
    posOf.forEach(({ x, y, n }) => {
      const cls = ['g-node', n.ok ? 'ok' : '', n.out ? 'out' : '', n.root ? 'root' : '', n.grp ? 'grp' : '', n.ui ? 'ui' : '', n.ext ? 'ext' : '', spec.focus ? (n.key === spec.focus ? 'focus' : near.has(n.key) ? '' : 'dim') : ''].filter(Boolean).join(' ');
      svg += `<g class="${cls}" ${n.attr} tabindex="0" role="button" aria-label="${esc(n.l2 + ', ' + n.l1)}"><title>${esc(n.tip)}</title>
        <rect class="g-box" x="${x}" y="${y}" width="${W0}" height="${NH}" rx="8"/>
        <rect class="g-bar" x="${x}" y="${y}" width="6" height="${NH}" rx="3"/>
        <text class="g-l1" x="${x + 15}" y="${y + 20}">${esc(trunc(n.l1, Math.floor((W0 - 70) / 6.4)))}</text>
        <text class="g-l2" x="${x + 15}" y="${y + 39}">${esc(trunc(n.l2, Math.floor((W0 - 24) / (n.ui ? 6.6 : 7.7))))}</text>
        <text class="g-cnt" x="${x + W0 - 10}" y="${y + 20}" text-anchor="end">${esc(n.cnt)}</text>
      </g>`;
    });
    more.forEach(({ x, y, hidden, L }) => {
      svg += `<g class="g-more" data-graph-open="${spec.id}:${L}" tabindex="0" role="button" aria-label="Show ${hidden} more"><rect x="${x}" y="${y}" width="${W0}" height="${NH}" rx="8"/><text x="${x + W0 / 2}" y="${y + NH / 2 + 4}" text-anchor="middle">+ ${hidden} more</text></g>`;
    });
    return svg + labels + '</svg>';
  }
  function graphSvg(c, tag) {
    const m = M();
    const focusKey = state.focus && state.focus.chain === c.id ? c.graph.nodes[state.focus.node].key : null;
    // By commit: the declarations other chains change that this one uses, dashed, in a last column.
    const last = Math.max(0, ...c.graph.nodes.map((n) => n.layer)) + 1;
    const ext = (c.ext || []).map((x, i) => ({ key: 'ext:' + i, x }));
    return layeredSvg({
      id: 'c' + c.id, marker: 'c' + c.id + (tag || ''), label: `Graph of the ${c.graph.nodes.length} changed members in this chain; arrows point from a change to what it uses${ext.length ? ', dotted when another chain changes it' : ''}.`, focus: focusKey,
      edges: c.graph.edges.concat(ext.flatMap(({ key, x }) => x.from.map((from) => ({ from, to: key, labels: [memberParts(x.name).name] })))),
      nodes: c.graph.nodes.map((n) => {
        const s = stats(n.blocks.map((id) => m.blockById.get(id)));
        const { l1, l2, owner } = nodeLabels(n);
        return { key: n.key, layer: n.layer, l1, l2, cnt: outOfLens(s) ? '' : s.open ? s.open + '/' + s.total : '✓ ' + s.total, ok: !s.open && !outOfLens(s), out: outOfLens(s), root: n.key === c.graph.root, grp: n.group !== null && n.group !== undefined,
          attr: `data-node="${n.idx}"`, tip: (owner ? owner + '.' : '') + l2 + ' · ' + n.file };
      }).concat(ext.map(({ key, x }, i) => ({ key, layer: last, l1: 'in ' + m.chains[x.chain].name, l2: memberParts(x.name).name, cnt: '↗', ext: true,
        attr: `data-act="ext-box" data-i="${i}"`, tip: `${x.name} · ${extWhere(c, x)} ${m.chains[x.chain].name}` }))),
    });
  }
  // Whether the chain that changes a declaration this one uses is read before it or after.
  const extWhere = (c, x) => { const order = chainOrder(); return order.indexOf(x.chain) > order.indexOf(c.id) ? 'changes later in' : 'changed in'; };
  // A member's uses of declarations other chains change (without a member, the chain's), by the
  // chain each is changed in. A name opens its change here; the chain's name, that chain.
  function extNoteHtml(c, n) {
    const m = M();
    const anchor = n ? n.key : 'chain';
    const byChain = new Map();
    (c.ext || []).forEach((x, i) => { if (n && !x.from.includes(n.key)) return; if (!byChain.has(x.chain)) byChain.set(x.chain, []); byChain.get(x.chain).push({ x, i }); });
    if (!byChain.size) return '';
    const open = state.peek && state.peek.ext && state.peek.ext.chain === c.id && state.peek.ext.anchor === anchor ? state.peek.ext.i : null;
    const parts = [...byChain].map(([id, list]) => {
      const names = list.slice(0, 3).map(({ x, i }) => `<button type="button" class="linkish" data-act="ext-peek" data-chain-id="${c.id}" data-anchor="${esc(anchor)}" data-i="${i}" aria-expanded="${open === i}" title="Show the change of ${esc(x.name)}"><code>${esc(memberParts(x.name).name)}</code></button>`);
      const more = list.length > 3 ? ` and ${list.length - 3} more` : '';
      const where = extWhere(c, list[0].x);
      const verb = where === 'changed in' ? 'changed in' : list.length > 1 ? 'which change later in' : 'which changes later in';
      return `${names.join(', ')}${more}, ${verb} <button type="button" class="linkish" data-chain="${id}">${esc(trunc(m.chains[id].name, 64))}</button>`;
    });
    return `<p class="sec-note">Uses ${parts.join('; ')}.</p>` + (open != null ? peekHtml(state.peek) : '');
  }
  // The change of a declaration another chain changes, from where this chain uses it: read only,
  // with the way to its chain.
  function extPeekHtml(p) {
    const m = M(), c = m.chains[p.ext.chain];
    const x = c && (c.ext || [])[p.ext.i];
    const b = x && m.blockById.get(x.block);
    const close = '<button type="button" class="pk-x" data-act="close-peek">Close</button>';
    if (!b) return `<div class="pk-h"><b>Change</b><span class="sp"></span>${close}</div>`;
    const f = b.file, h = f.hunks[b.hunk];
    const s0 = Math.max(0, b.first - 3), e0 = Math.min(h.rows.length, b.first + b.len + 3);
    // As in the diff: the tokens that changed stand out only where lines were both removed and added.
    const emphasis = b.adds > 0 && b.dels > 0;
    let rows = '';
    for (let i = s0; i < e0; i++) {
      const [type, text, ranges] = h.rows[i];
      const meta = h.meta[i];
      const hit = type !== '-' && meta.n === x.line;
      rows += `<div class="pk-ln${type === '+' ? ' add' : type === '-' ? ' del' : ''}${f.lang === 'md' ? ' md' : ''}${hit ? ' hit' : ''}"><span class="no">${meta.o ?? ''}</span><span class="no">${meta.n ?? ''}</span><span class="sg">${type === '-' ? '−' : type === '+' ? '+' : ''}</span><span class="tx">${codeHtml(f, text, ranges, { emphasis: emphasis && type !== ' ', colors: rowColors(h.rows, f.p, i) })}</span></div>`;
    }
    return `<div class="pk-h"><b>${esc(memberParts(x.name).name)}</b><span class="pk-loc">${esc(f.p)}:${x.line}</span><span class="pk-src">${extWhere(c, x)} ${esc(trunc(m.chains[x.chain].name, 48))}</span><span class="pk-src">${done(b) ? 'reviewed' : 'not reviewed'}</span><span class="sp"></span>`
      + `<button type="button" class="btn xs primary" data-act="ext" data-to="${x.chain}" data-block="${esc(x.block)}">Open its chain</button>${close}</div>`
      + `<div class="pk-code" tabindex="0" aria-label="The change of ${esc(x.name)}" data-peek-code="ext:${esc(x.block)}">${rows}</div>`;
  }
  function mapSvg(fam) {
    const ids = new Set(fam.chains.map((c) => c.id));
    // Only direct dependencies: an arrow already implied by a longer path is left out.
    const out = new Map(fam.chains.map((c) => [c.id, c.uses.filter((o) => ids.has(o) && o !== c.id)]));
    const reach = (from, to, skip) => {
      const seen = new Set([from]), stack = out.get(from).filter((x) => !(from === skip[0] && x === skip[1]));
      while (stack.length) { const x = stack.pop(); if (x === to) return true; if (seen.has(x)) continue; seen.add(x); stack.push(...out.get(x)); }
      return false;
    };
    const edges = [];
    fam.chains.forEach((c) => out.get(c.id).forEach((o) => { if (!reach(c.id, o, [c.id, o])) edges.push({ from: 'k' + c.id, to: 'k' + o, labels: [] }); }));
    // Chains that share changes are one family too. One dashed line joins each group of chains
    // that uses links to the chain it shares the most changes with.
    const group = new Map(fam.chains.map((c) => [c.id, c.id]));
    const find = (x) => { while (group.get(x) !== x) x = group.get(x); return x; };
    fam.chains.forEach((c) => out.get(c.id).forEach((o) => group.set(find(c.id), find(o))));
    const pairs = [];
    fam.chains.forEach((c) => (c.shares || []).forEach((o) => {
      if (o <= c.id || !ids.has(o)) return;
      const ob = new Set(M().chains[o].blocks);
      pairs.push({ a: c, b: M().chains[o], n: c.blocks.filter((x) => ob.has(x)).length });
    }));
    pairs.sort((x, y) => y.n - x.n || x.a.id - y.a.id || x.b.id - y.b.id);
    pairs.forEach(({ a, b }) => {
      if (find(a.id) === find(b.id)) return;
      group.set(find(a.id), find(b.id));
      const [from, to] = a.depth <= b.depth ? [a, b] : [b, a];
      edges.push({ from: 'k' + from.id, to: 'k' + to.id, labels: [], share: true });
    });
    return layeredSvg({
      id: 'map' + fam.id, w: 236, cap: 9, faintLong: true, label: `Map of ${fam.chains.length} linked chains; arrows point from a chain to the chains its root member uses, and dashed lines join chains that share changes.`,
      edges,
      nodes: fam.chains.map((c) => {
        const s = stats(blocksOf(c.blocks));
        const cls = /^(_?[A-Z][\w$]*)\.(.+)$/.exec(c.name);
        return { key: 'k' + c.id, layer: c.depth, l1: cls ? cls[1] : c.kind === 'group' && !c.rootKind ? 'same change' : '', l2: cls ? cls[2] : c.name, cnt: outOfLens(s) ? '' : s.open ? s.open + '/' + s.total : '✓ ' + s.total, out: outOfLens(s), ok: !s.open, root: c === fam.top,
          attr: `data-chain="${c.id}"`, tip: c.name };
      }),
    });
  }

  // ---------- whole files and the editor
  // A button that opens a file whole: { side, p } in the repository, or { ext } outside it.
  function sourceButton(loc, label, cls) {
    if (!CONFIG.served || (!loc.p && loc.ext == null)) return '';
    return `<button type="button" class="${cls || 'btn sm'}" data-act="open-source" data-side="${loc.side || ''}" data-p="${esc(loc.p || '')}" data-ext="${loc.ext != null ? loc.ext : ''}" data-line="${loc.line || ''}" data-label="${esc(loc.label || '')}" data-where="${esc(loc.where || '')}">${label}</button>`;
  }
  let rootsAsked = false;
  const dataAttrs = (data) => Object.entries(data || {}).map(([k, v]) => ` data-${k}="${esc(String(v))}"`).join('');
  // Where "Open in editor" goes: a command untangle runs (a button's data), or a link built from
  // the editor's URL template.
  function editorTarget(loc) {
    if (!CONFIG.served || !CONFIG.editor) return null;
    if (CONFIG.editor.mode === 'orca' && (!loc.side || !loc.p)) return null;
    const line = loc.line || 1, col = loc.col || 0;
    if (CONFIG.editor.mode === 'command' || CONFIG.editor.mode === 'orca') return { data: { act: 'open-editor', side: loc.side || '', p: loc.p || '', ext: loc.ext != null ? loc.ext : '', line, col } };
    let abs = loc.abs || null;
    if (!abs && loc.side && loc.p) {
      if (!CONFIG.roots) {
        if (!rootsAsked) { rootsAsked = true; api('roots').then((r) => r.json()).then((j) => { if (j.head) { CONFIG.roots = j; render(); } }).catch(() => {}); }
        return null;
      }
      abs = CONFIG.roots[loc.side] + '/' + loc.p;
    }
    if (!abs) return null;
    return { href: CONFIG.editor.template.replace('{file}', encodeURI(abs)).replace('{line}', line).replace('{col}', col + 1), title: `${abs}:${line}` };
  }
  // "Open in editor" as a small button (in a peek), or as an item of a view's menu.
  function editorHtml(loc) {
    const t = editorTarget(loc);
    if (!t) return '';
    const label = editorLabel();
    return t.href ? `<a class="btn xs" href="${esc(t.href)}" title="${esc(t.title)}">Open in editor</a>` : `<button type="button" class="btn xs"${dataAttrs(t.data)}>${label}</button>`;
  }
  const editorLabel = () => CONFIG.editor && CONFIG.editor.mode === 'orca' ? 'Open in Orca' : 'Open in editor';
  const editorItem = (loc) => { const t = editorTarget(loc); return t ? { label: editorLabel(), icon: ICON.goToFile, href: t.href, title: t.title, data: t.data } : null; };

  // ---------- menus: the view's ⋯, the sidebar's ···, a file's chains, a folder of its breadcrumb,
  // the head commit's "Changes from". One at a time, under the button that opened it; items are
  // the page's usual buttons (data-act, data-chain, …).
  // crumb: the folder a breadcrumb's menu went to, from the folder it opened on; want: the menu
  // that opens once what it lists has come; shown: the menu on screen, while it opens and after.
  const MENU = { open: null, el: null, html: '', crumb: null, want: null, shown: null };
  const chainItem = (c) => { const st = stats(blocksOf(c.blocks)); const n = splitName(c.name); return { label: n.name, own: n.own, mono: !proseName(c), icon: ICON.chain, data: { chain: c.id }, key: st.open ? `${st.open} to review` : 'reviewed' }; };
  // What a view's ⋯ holds: how it shows the code, and where else to go from it.
  function viewMenuItems() {
    const v = state.view, m = M(), items = [];
    const showing = () => {
      items.push({ label: 'Side by side', checked: state.layout === 'split', data: { act: 'layout' } });
      items.push({ label: 'Diffs of reviewed code', checked: state.showReviewedDiff, data: { act: 'revdiff' } });
      if (v.kind !== 'tests') items.push({ label: 'Minimap', checked: UI.minimap, data: { act: 'minimap' } });
    };
    const fileItems = (f, gen) => {
      const firstAdd = !gen && f.blocks.find((b) => b.adds);
      const ed = editorItem({ side: f.s === 'D' ? 'base' : 'head', p: f.p, line: (firstAdd && f.hunks[firstAdd.hunk].meta[firstAdd.first].n) || 1 });
      if (ed) items.push(ed, { sep: true });
      showing();
      const more = [];
      if (localMode() ? NT.data : GH.on && GH.data && !GH.data.pr.locked) more.push({ label: localMode() ? 'Write a note on this file' : 'Comment on this file', icon: ICON.comment, data: { act: 'file-comment', p: f.p } });
      if (CONFIG.served && f.s === 'M') more.push({ label: 'The file before these changes', icon: ICON.file, data: { act: 'open-source', side: 'base', p: f.p } });
      if (more.length) items.push({ sep: true }, ...more);
    };
    if (v.kind === 'chain') {
      const c = m.chains[v.id];
      if (!c) return items;
      showing();
      const usedBy = m.usedBy.get(c.id);
      if (usedBy.length) items.push({ head: 'Used by' }, ...usedBy.map((o) => chainItem(m.chains[o])));
      if (c.uses.length) items.push({ head: 'Uses' }, ...c.uses.map((o) => chainItem(m.chains[o])));
      if (c.also.length) items.push({ note: `Also carries ${c.also.map((x) => `<code>${esc(x)}</code>`).join(', ')}.` });
    } else if (v.kind === 'file') {
      const f = m.files.find((x) => x.p === v.path);
      const g = !f && m.generated.find((x) => x.p === v.path);
      if (f) fileItems(f, false);
      else if (g) fileItems(g, true);
    } else if (v.kind === 'standalone' || v.kind === 'group' || v.kind === 'tests') showing();
    else if (v.kind === 'source') {
      const s = sources.get(srcKey(v)) || {};
      const ed = editorItem({ side: v.side, p: v.path, ext: v.ext, abs: s.abs, line: v.line || 1 });
      if (ed) items.push(ed);
      const f = v.ext == null && m.files.find((x) => x.p === v.path);
      if (f && f.s === 'M') items.push({ label: v.side === 'base' ? 'The file after these changes' : 'The file before these changes', icon: ICON.file, data: { act: 'open-source', side: v.side === 'base' ? 'head' : 'base', p: v.path } });
      items.push({ label: 'Minimap', checked: UI.minimap, data: { act: 'minimap' } });
    }
    return items;
  }
  // The sidebar's ···: a panel saying where the marks are kept, with a way to start over.
  function sideMenuItems() {
    const items = [];
    const sn = CONFIG.snapshot;
    if (!CONFIG.served) items.push({ note: 'Your marks are kept in this browser.' });
    else if (sn) items.push({ note: `Your marks are kept in git as <code>${esc(sn.ref)}</code>${sn.commit ? `, at <code>${esc(sn.commit.slice(0, 7))}</code>` : ''}. <code>git diff ${esc(sn.ref)} ${esc((CONFIG.head || '').slice(0, 7))}</code> shows what’s left.${sn.note ? ` ${esc(sn.note)}` : ''}` });
    else items.push({ note: 'Your marks are saved as you go.' });
    items.push({ button: 'Reset all marks…', title: 'Mark every change unreviewed again', data: { act: 'reset' } });
    return items;
  }
  function chainsMenuItems() {
    const m = M(), f = state.view.kind === 'file' && m.files.find((x) => x.p === state.view.path);
    if (!f) return [];
    const ids = [...new Set(f.blocks.flatMap((b) => m.chainsOf.get(b.id) || []))];
    return [{ head: `The chains this file’s changes are in` }, ...ids.map((id) => chainItem(m.chains[id]))];
  }
  // By commit: the other chains the open chain's commits wrote lines in, each opening that chain
  // through the commit, as History's chips do.
  function alsoMenuItems() {
    const m = M(), v = state.view, c = v.kind === 'chain' && m.byCommit ? m.chains[v.id] : null;
    if (!c) return [];
    const fam = m.families.find((f) => f.id === c.family);
    const items = [];
    let last = -1;
    alsoIn(c, fam).forEach((x) => {
      const sha = HISTORY.commits[x.ci].sha, to = m.chains[x.chain];
      if (x.ci !== last) { items.push({ head: `Where ${shortSha(sha)} also wrote lines` }); last = x.ci; }
      items.push({ ...chainItem(to), key: plural(x.n, 'change'), title: `${to.name}, through ${shortSha(sha)}: only its lines there`, data: { act: 'lens-chain', sha, 'chain-id': to.id } });
    });
    return items;
  }
  // A breadcrumb's folder: its folders (one holding only a folder shows with it, as in the Files
  // tab) and its files, the review's with their marks. A folder opens in the menu, and .. goes
  // up; what leads to the file open is current. The review's files open in their diff, the
  // repository's others whole.
  const parentOf = (dir) => dir.slice(0, Math.max(0, dir.lastIndexOf('/')));
  const crumbDir = () => (MENU.crumb != null ? MENU.crumb : (state.view.path || '').split('/').slice(0, Number(MENU.open.slice('crumb:'.length)) + 1).join('/'));
  // The repository's files at the head, asked of untangle once, as a breadcrumb first shows.
  const REPO = { files: null, asked: null };
  function repoFiles() {
    if (CONFIG.served && !REPO.asked) {
      REPO.asked = api('files').then(okJson).then((j) => { REPO.files = j.files; }, () => { REPO.files = []; })
        .then(() => { if (MENU.open && MENU.open.startsWith('crumb:')) renderMenu(); });
    }
    return REPO.asked;
  }
  // The folders of the review's files, generated ones too, with the repository's other files.
  function crumbTree() {
    const m = M();
    if (m.crumbTree && m.crumbTree.repo === REPO.files) return m.crumbTree.root;
    const ours = m.files.concat(m.generated), have = new Set(ours.map((f) => f.p));
    const root = fileTree(ours.concat((REPO.files || []).filter((p) => !have.has(p)).map((p) => ({ p, out: true }))));
    m.crumbTree = { repo: REPO.files, root };
    return root;
  }
  function crumbMenuItems() {
    const m = M(), path = state.view.path || '', dir = crumbDir();
    const root = crumbTree();
    const at = (p) => (p ? p.split('/') : []).reduce((node, name) => node && node.dirs.get(name), root);
    const node = at(dir), items = [{ head: dir ? shortDir(dir) + '/' : 'Top level' }];
    if (dir) {
      // Up past the folders that hold only this one: they show with it.
      let up = parentOf(dir);
      for (let n = at(up); up && n && n.dirs.size === 1 && !n.files.length; n = at(up)) up = parentOf(up);
      items.push({ label: '..', icon: ICON.up, title: `Up to ${up ? up + '/' : 'the top level'}`, data: { act: 'crumb-dir', folder: up, up: 1 } });
    }
    if (!node) return items.concat({ note: 'None of this review’s files are in it.' });
    const gen = new Set(m.generated.map((f) => f.p));
    // Generated files have no changes to review: their mark is a ring. The repository's other
    // files have none.
    const markOf = (files) => {
      const own = files.filter((f) => !f.out && !gen.has(f.p));
      if (!own.length) return files.some((f) => gen.has(f.p)) ? { icon: '<i class="mk gen"></i>', key: '', words: 'generated, not reviewed' } : { icon: '', key: '', words: 'no changes in this review' };
      const st = stats(own.flatMap((f) => f.blocks));
      return { icon: markHtml(st), key: st.open ? String(st.open) : '', words: leftWords(st) };
    };
    [...node.dirs.values()].sort((x, y) => byName(x.name, y.name)).forEach((d) => {
      let name = d.name;
      while (d.dirs.size === 1 && !d.files.length) { d = [...d.dirs.values()][0]; name += '/' + d.name; }
      const k = markOf(filesIn(d));
      items.push({ label: name + '/', mono: true, icon: k.icon, key: k.key, current: path.startsWith(d.path + '/'), title: `${d.path}/: ${k.words}`, data: { act: 'crumb-dir', folder: d.path } });
    });
    node.files.slice().sort((x, y) => byName(fileName(x.p), fileName(y.p))).forEach((f) => {
      const k = markOf([f]);
      items.push({ label: fileName(f.p), mono: true, icon: k.icon, key: k.key, current: f.p === path, title: `${f.p}: ${k.words}`, data: f.out ? { act: 'open-source', side: 'head', p: f.p } : { open: f.p } });
    });
    return items;
  }
  // ⋯ in a narrow window's app bar: what the top bar holds in a wide one (the notes or the review,
  // the commit, the language server), and the view's own menu.
  function moreMenuItems() {
    const items = [];
    if (GH.on || NT.on) {
      const d = GH.data, n = d && d.pending ? d.pending.comments : 0;
      const open = NT.data ? NT.data.notes.filter((x) => !x.resolved).length : 0;
      items.push(localMode()
        ? { label: open ? `Your notes · ${open} open` : 'Your notes', icon: ICON.comment, data: { act: 'review-toggle' }, title: 'Copy them for your agent, or post them to GitHub' }
        : { label: n ? `Finish your review · ${n} pending` : 'Review the pull request', icon: ICON.comment, data: { act: 'review-toggle' } });
    }
    const sha = (CONFIG.head || M().raw.right || '').slice(0, 7);
    if (hxOn()) items.push({ label: state.lens ? `Changes from ${lensLabel()}` : `Changes from every commit, at ${sha}`, icon: ICON.history, data: { act: 'menu', menu: 'lens' } });
    if (CONFIG.served) items.push({ label: 'Look for new commits', icon: ICON.refresh, data: { act: 'refresh' } });
    // The view's menu, but for what a narrow window doesn't show.
    const view = viewMenuItems().filter((it) => !(it.data && (it.data.act === 'minimap' || it.data.act === 'layout')))
      .filter((it, i, all) => !it.sep || (i > 0 && i < all.length - 1 && !all[i - 1].sep));
    items.push({ sep: true }, { head: 'Code' }, { label: 'Wrap long lines', checked: wrapOn(), data: { act: 'wrap' }, title: 'Long lines wrap under their own indent, instead of running off the side' },
      { note: `<span class="mi-size">Code size<span class="sp"></span><button type="button" class="ib" data-act="code-size" data-step="-1" aria-label="Smaller code"${codeSize() <= 10 ? ' disabled' : ''}>A−</button><b>${codeSize()}</b><button type="button" class="ib" data-act="code-size" data-step="1" aria-label="Larger code"${codeSize() >= 16 ? ' disabled' : ''}>A+</button></span>` });
    // A chain's own action, from the header that scrolled away.
    const ch = state.view.kind === 'chain' && M().chains[state.view.id];
    if (ch) {
      const st = stats(blocksOf(ch.blocks));
      if (!outOfLens(st)) view.unshift({ label: st.open ? 'Mark the whole chain reviewed' : 'Mark the whole chain unreviewed', icon: ICON.check, data: { act: 'mark-chain', 'chain-id': ch.id } });
    }
    if (state.view.kind === 'tests') {
      const mode = UI.testsMode === 'sentences' ? 'sentences' : 'nested';
      view.unshift({ label: 'Nested, as the code nests them', checked: mode === 'nested', data: { act: 'tests-mode', v: 'nested' } }, { label: 'Sentences, each whole', checked: mode === 'sentences', data: { act: 'tests-mode', v: 'sentences' } },
        { label: 'Each test’s details', checked: testDetails(), data: { act: 'test-details' }, title: 'Its expects, the lines it changed, its commit, and a way into the file: on every test, or on the one you open' });
    }
    if (view.length) items.push({ sep: true }, ...(view[0].head ? [] : [{ head: 'This view' }]), ...view);
    const lsp = $('#vw-lsp');
    if (lsp && !lsp.hidden) {
      const m = (k) => esc(((lsp.querySelector(`[data-m="${k}"]`) || {}).textContent || '…').trim());
      items.push({ sep: true }, { head: 'Language server' }, { note: `${esc(($('#lsp-state') || {}).textContent || '')}: ${m('lspRss')}, CPU ${m('lspCpu')}. untangle: ${m('rss')}, CPU ${m('cpu')}.` });
      if (!$('#lsp-free').hidden) items.push({ label: 'Free its memory', title: $('#lsp-free').title, data: { act: 'lsp-restart' } });
    }
    return items;
  }
  // A comment's tools as a menu, each by its name: what its ⋯ opens on a touch screen.
  function cmMenuItems(anchor) {
    const tools = anchor.closest('.cm') && anchor.closest('.cm').querySelector('.cm-tools');
    return tools ? [...tools.children].map((b) => {
      const label = b.getAttribute('aria-label') || b.title;
      const data = Object.fromEntries(Object.entries(b.dataset).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), v]));
      return b.tagName === 'A' ? { label, href: b.getAttribute('href'), icon: b.innerHTML } : { label, icon: b.innerHTML, data };
    }) : [];
  }
  function menuHtml(items) {
    return items.map((it) => {
      if (it.sep) return '<div class="mi-sep" role="separator"></div>';
      if (it.head) return `<div class="mi-h">${esc(it.head)}</div>`;
      if (it.note) return `<div class="mi-note">${it.note}</div>`;
      if (it.button) return `<div class="mi-foot"><button type="button" class="btn sm"${it.title ? ` title="${esc(it.title)}"` : ''}${dataAttrs(it.data)}>${esc(it.button)}</button></div>`;
      const role = it.checked != null ? 'menuitemcheckbox' : 'menuitem';
      const inner = `<span class="ic">${it.checked != null ? (it.checked ? ICON.check : '') : it.icon || ''}</span><span${it.mono ? ' class="nm"' : ''}>${it.own ? `<span class="own">${esc(it.own)}</span>` : ''}${esc(it.label)}</span><span class="k">${esc(it.key || '')}</span>`;
      if (it.href) return `<a class="mi" role="${role}" href="${esc(it.href)}"${/^https?:/.test(it.href) ? ' target="_blank" rel="noopener noreferrer"' : ''}${it.title ? ` title="${esc(it.title)}"` : ''}>${inner}</a>`;
      return `<button type="button" class="mi" role="${role}"${it.checked != null ? ` aria-checked="${it.checked}"` : ''}${it.current ? ' aria-current="true"' : ''}${it.title ? ` title="${esc(it.title)}"` : ''}${dataAttrs(it.data)}>${inner}</button>`;
    }).join('');
  }
  // Draws the open menu under its button (found again after each render), or closes it when the
  // button is gone. Drawn again only when it changed: what has the focus, and the commits' list
  // scrolled, stay.
  function renderMenu() {
    if (!MENU.el) { MENU.el = document.createElement('div'); MENU.el.className = 'menu'; MENU.el.hidden = true; viewer.appendChild(MENU.el); sheetTouch(MENU.el); }
    const el = MENU.el, lens = MENU.open === 'lens';
    const crumb = !!MENU.open && MENU.open.startsWith('crumb:');
    const anchors = MENU.open ? [...viewer.querySelectorAll(`[data-menu="${MENU.open}"]`)] : [];
    const anchor = anchors.find((a) => a.getClientRects().length) || anchors[0];
    const revs = MENU.open === 'reviews';
    const items = !anchor || lens || revs ? [] : MENU.open === 'view' ? viewMenuItems() : MENU.open === 'more' ? moreMenuItems() : MENU.open === 'side' ? sideMenuItems() : MENU.open === 'also' ? alsoMenuItems() : crumb ? crumbMenuItems() : MENU.open.startsWith('cm:') ? cmMenuItems(anchor) : chainsMenuItems();
    const sheet = compact();
    const html = !anchor ? '' : (sheet ? SHEET_HANDLE : '') + (revs ? revsPopHtml() : lens ? (hxOn() ? lensPopHtml() : '') : items.length ? menuHtml(items) : '');
    if (!html || html === SHEET_HANDLE) {
      MENU.open = null;
      MENU.html = '';
      layerSoon();
      viewer.querySelectorAll('[data-menu][aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
      // It folds back into its button as it was, out of reach, then hides.
      if (MENU.shown) { MENU.shown = null; el.inert = true; pop(el, false, () => { el.hidden = true; el.inert = false; }); }
      return;
    }
    // The marks' panel says something and has one button, and "Changes from" holds a list: dialogs.
    el.setAttribute('role', MENU.open === 'side' || lens || revs ? 'dialog' : 'menu');
    el.setAttribute('aria-label', MENU.open === 'side' ? 'Marks' : MENU.open === 'more' ? 'More' : lens ? 'Changes from' : revs ? 'Your reviews' : MENU.open === 'chains' || MENU.open === 'also' ? 'Chains' : crumb ? 'The files in a folder' : 'More');
    el.classList.toggle('panel', MENU.open === 'side');
    el.classList.toggle('revs-pop', revs);
    el.classList.toggle('lens-pop', lens);
    el.classList.toggle('sheet', sheet);
    if (html !== MENU.html) {
      const list = el.querySelector('.lp-list'), top = list ? list.scrollTop : 0;
      el.innerHTML = html;
      MENU.html = html;
      const again = el.querySelector('.lp-list');
      if (again) again.scrollTop = top;
    }
    el.hidden = false;
    el.inert = false;
    anchor.setAttribute('aria-expanded', 'true');
    layerSoon();
    // A sheet rises from the bottom of the window, wherever its button is.
    if (sheet) {
      el.style.left = el.style.top = '';
      if (MENU.shown !== MENU.open) { el.style.transformOrigin = '50% 100%'; if (MENU.shown) unpop(el); MENU.shown = MENU.open; pop(el, true); }
      return;
    }
    const r = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.max(8, Math.min(MENU.open === 'side' || MENU.open === 'chains' || lens || crumb || revs ? r.left : r.right - w, window.innerWidth - w - 8));
    const top = r.bottom + 6 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    // Opened, or another menu in its place: it grows from its button.
    if (MENU.shown !== MENU.open) {
      el.style.transformOrigin = `${Math.round(r.left + r.width / 2 - left)}px ${top < r.top ? '100%' : '0'}`;
      if (MENU.shown) unpop(el);
      MENU.shown = MENU.open;
      pop(el, true);
    }
  }
  function toggleMenu(kind) {
    // A breadcrumb's folder opens once untangle has said what else is in it: asked as the
    // breadcrumb first showed, that's at once. A second click while it's asked cancels.
    if (kind.startsWith('crumb:') && MENU.open !== kind && CONFIG.served && !REPO.files) {
      MENU.want = MENU.want === kind ? null : kind;
      repoFiles().then(() => { if (MENU.want === kind) { MENU.want = null; toggleMenu(kind); } });
      return;
    }
    MENU.want = null;
    MENU.open = MENU.open === kind ? null : kind;
    MENU.html = '';
    MENU.crumb = null;
    if (MENU.open === 'lens') loadCommits();
    if (MENU.open === 'reviews') rvLoad();
    renderMenu();
    // A menu's current item takes the focus, else its first; "Changes from" the scope it has; the
    // marks' panel takes none (its one button resets).
    menuFocus(MENU.open && (MENU.open === 'lens' ? MENU.el.querySelector('[aria-pressed="true"]') || MENU.el.querySelector('button') : MENU.el.querySelector('.mi[aria-current="true"]') || MENU.el.querySelector('.mi')));
  }
  // An item of the open menu takes the focus: in "Changes from"'s list, a third of the way down;
  // in a menu longer than it can show, there too when it's off it.
  function menuFocus(it) {
    if (!it) return;
    it.focus({ preventScroll: true });
    const list = it.closest('.lp-list'), el = MENU.el;
    if (list) list.scrollTop = it.offsetTop - list.clientHeight / 3;
    else if (it.offsetTop < el.scrollTop || it.offsetTop + it.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = it.offsetTop - el.clientHeight / 3;
  }
  function closeMenu() { MENU.want = null; if (MENU.open) { MENU.open = null; renderMenu(); } }
  const sources = new Map();
  const srcKey = (v) => (v.commit ? 'commit:' + v.commit + ':' + v.path : v.ext != null ? 'ext:' + v.ext : v.side + ':' + v.path);
  let pendingLine = null;
  // A whole file from untangle. When it arrives, the view that showed it loading shows it, with
  // the line on screen kept where it was. `wanted`: a view is waiting for it (else it's loaded ahead).
  function loadSource(v, wanted) {
    const key = srcKey(v);
    if (sources.has(key)) {
      const s = sources.get(key);
      if (wanted && s.wanted !== true) s.wanted = wanted;
      return s;
    }
    const s = { status: 'loading', wanted: wanted || false };
    sources.set(key, s);
    const q = new URLSearchParams(v.commit ? { sha: v.commit, p: v.path } : v.ext != null ? { ext: String(v.ext) } : { side: v.side, p: v.path });
    api((v.commit ? 'commit-file?' : 'file?') + q).then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.status); return j; }))
      .then((j) => {
        if (v.commit) {
          Object.assign(s, { ...j, change: j.status, status: 'ok' });
          return;
        }
        const lines = j.text === '' ? [] : j.text.replace(/\r?\n$/, '').split(/\r?\n/);
        Object.assign(s, { status: 'ok', text: j.text, lines, count: lines.length, abs: j.abs, generated: j.generated, line: j.line, deleted: j.deleted, revision: j.revision });
      })
      .catch((e) => Object.assign(s, { status: 'error', error: e.message }))
      .then(() => {
        if (state.view.kind === 'source' && srcKey(state.view) === key) return render(state.view.line ? { line: state.view.line } : { top: true });
        if (!s.wanted) return;
        // Only a peek waits for it: only the peek changes.
        if (s.wanted === 'peek') return state.peek && main.querySelector(PEEK) ? updatePeek() : undefined;
        if (pendingLine && pendingLine.view === state.view) { const line = pendingLine.line; pendingLine = null; return render({ line }); }
        const at = lineOnScreen();
        render();
        backTo(at);
      });
    return s;
  }
  // A whole file at one side, or outside the repository. Names in it ask the server where
  // they are defined; lines this review changes are marked.
  function renderSource(v) {
    const s = loadSource(v);
    const name = v.ext != null ? v.label || 'file' : v.path;
    const f = v.ext == null ? M().files.find((x) => x.p === v.path) : null;
    const g = v.ext == null ? M().generated.find((x) => x.p === v.path) : null;
    const sha = v.side === 'base' ? CONFIG.base : CONFIG.head;
    const changed = new Set();
    if (f) f.hunks.forEach((hk) => hk.meta.forEach((r) => { if (v.side === 'base' ? r.t === '-' : r.t === '+') changed.add(v.side === 'base' ? r.o : r.n); }));
    const where = v.ext != null ? esc(v.where || 'Outside the repository') : `${v.side === 'base' ? 'Before' : 'After'} these changes, at ${esc((sha || '').slice(0, 7))}`;
    let h = headerHtml({
      crumbs: v.ext != null ? `<span>${esc(cap(v.where || 'outside the repository'))}</span>${SEP}<b title="${esc(name)}">${esc(fileName(name))}</b>` : fileCrumbs(name),
      facts: `${where}${s.lines ? ` · ${linesWord(s.lines.length)}` : ''}${changed.size ? ` · <span class="${v.side === 'base' ? 'd' : 'a'}">${linesWord(changed.size)} ${v.side === 'base' ? 'removed' : 'added'} by this review</span>` : ''}${s.generated || g ? ' · generated' : ''}`,
      action: f || g ? `<button type="button" class="btn" data-open="${esc(v.path)}">Show the changes</button>` : '',
    });
    if (s.status === 'loading') return h + '<div class="empty">Loading the file…</div>';
    if (s.status === 'error') return h + `<div class="empty">${esc(s.error)}</div>`;
    const colors = textColors(s.text, name);
    const key = srcKey(v);
    const file = { p: name, lang: C.langOf(name) };
    h += '<div class="code src">';
    s.lines.forEach((text, i) => {
      const ln = i + 1, c = changed.has(ln);
      h += `<div class="ln ${c ? (v.side === 'base' ? 'del' : 'add') : 'ctx'}${file.lang === 'md' ? ' md' : ''}"${indentAttr(text)} data-n="${ln}"><span class="g"></span><span class="no">${ln}</span><span class="sg">${c ? (v.side === 'base' ? '−' : '+') : ''}</span><span class="tx">${codeHtml(file, text, null, { colors: colors && colors[i], live: { side: v.side, p: v.path, ext: v.ext, line: ln } })}</span></div>`;
      if (state.peek && state.peek.src && state.peek.src.key === key && state.peek.src.line === ln) h += peekHtml(state.peek);
    });
    return h + '</div>';
  }
  function openSource(d) {
    const ext = d.ext !== '' && d.ext != null ? Number(d.ext) : null, side = d.side || (ext == null ? 'head' : null);
    // A file this review changes opens in its diff, whole.
    const f = side === 'head' && d.p ? M().files.find((x) => x.p === d.p && x.s !== 'D') : null;
    if (f) { if (f.s === 'M') state.whole.add(f.p); return openFile(f.p, d.line); }
    state.view = { kind: 'source', side, path: d.p || null, ext, line: d.line ? Number(d.line) : null, label: d.label || null, where: d.where || null };
    state.peek = null;
    render(state.view.line ? { line: state.view.line } : { top: true });
  }
  // A name clicked anywhere without an answer computed ahead: ask the server. The peek opens
  // under the line; clicked inside a peek, the peek moves to the new definition (Back returns).
  const anchorOf = (p) => ({ path: p.path, n: p.n, old: p.old, o: p.o, col: p.col, src: p.src, moveOf: p.moveOf });
  // A question to the language server about the name at a position.
  function askAt(route, q) {
    const params = new URLSearchParams({ l: String(q.l), c: String(q.c) });
    if (q.side) params.set('side', q.side);
    if (q.p) params.set('p', q.p);
    if (q.ext != null) params.set('ext', String(q.ext));
    return api(route + '?' + params).then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.status); return j; }));
  }
  // Where a name is defined, asked of the language server: { q, status: 'ok', target }, or
  // status 'none' or 'error'.
  function askDefinition(q) {
    return askAt('definition', q)
      .then((j) => (j.target ? { q, status: 'ok', target: j.target } : { q, status: 'none' }))
      .catch((e) => ({ q, status: 'error', error: e.message }));
  }
  // The lines that use a name (kind 'usages') or that implement it ('implementations'), asked of
  // the language server: { q, kind, status: 'ok', list, truncated }, or status 'error'.
  function askList(kind, q) {
    return askAt(kind, q)
      .then((j) => ({ q, kind, status: 'ok', list: j[kind], truncated: j.truncated }))
      .catch((e) => ({ q, kind, status: 'error', error: e.message }));
  }
  // Whether the language server's definition of a name is that name itself: it was clicked where
  // it's declared.
  const declares = (q, t) => !!t && (t.side || null) === (q.side || null) && (t.side ? t.p === q.p : t.ext === q.ext) && t.l === q.l && t.c === q.c;
  // The same for a definition answered ahead of time, which keeps no column: it's on the name's own
  // line, and the name is the line's first that leads there (a parameter's uses can share its line).
  function declaredHere(el) {
    const d = el.dataset, old = d.o !== undefined, line = Number(old ? d.o : d.n), ti = Number(d.ti);
    const t = (old ? DEFS_OLD[state.compare] : defsNow()).targets[ti];
    if (!t || t.w !== 'repo' || t.p !== d.path || t.l !== line) return false;
    const cols = [...((old ? oldLineDefs(d.path, line) : lineDefs(d.path, line)) || [])].filter(([, x]) => x === ti).map(([c]) => c);
    return Math.min(...cols) === Number(d.col);
  }
  // A name clicked where it's declared shows the lines that use it, in a peek like the changed
  // usages': one picked shows above the list, and picked again opens. Clicked inside a peek, it
  // takes that peek's place (Back returns).
  function showUsages(q, el) {
    const cur = el.closest('.peek') && state.peek;
    let peek;
    if (cur) peek = { ...anchorOf(cur), back: [...(cur.back || []), cur] };
    else if (state.view.kind === 'source') peek = { src: { key: srcKey(state.view), line: q.l } };
    else if (q.side === 'base') peek = { old: true, path: q.p, o: q.l, col: q.c };
    else peek = { path: q.p, n: q.l, col: q.c };
    state.peek = peek;
    fillUsages(peek, q, el);
    if (cur) updatePeek(); else render();
  }
  // The same for a name whose definition was answered ahead; clicked again, the peek closes.
  function refUsages(el) {
    const d = el.dataset, old = d.o !== undefined;
    const q = { side: old ? 'base' : 'head', p: d.path, ext: null, l: Number(old ? d.o : d.n), c: Number(d.col) };
    const U = state.peek && !state.peek.back && state.peek.uses;
    if (U && U.q.side === q.side && U.q.p === q.p && U.q.l === q.l && U.q.c === q.c) { state.peek = null; return render(); }
    showUsages(q, el);
  }
  function fillUsages(peek, q, el) {
    delete peek.live;
    fillList(peek, 'usages', q, nameOf(el));
  }
  // A peek's list of the lines that use a name or implement it, loading, then answered.
  function fillList(peek, kind, q, name) {
    peek.uses = { q, kind, name, status: 'loading' };
    peek.sel = null;
    askList(kind, q).then((answer) => { peek.uses = { ...answer, name }; if (state.peek === peek) updatePeek(); });
  }
  const nameOf = (el) => el.textContent.replace(/^@/, '');
  const nameIn = (text, col) => (/^[A-Za-z_$][\w$]*/.exec(text.slice(col)) || [''])[0];
  // What implements the name a peek is about (a class's subtypes, a member's overrides), listed in
  // the peek's place: Back returns.
  function showImplementations() {
    const cur = state.peek, about = cur && peekSubject(cur);
    if (!about) return;
    const peek = { ...anchorOf(cur), back: [...(cur.back || []), cur] };
    fillList(peek, 'implementations', about.q, about.name);
    state.peek = peek;
    updatePeek();
  }
  // The name a peek is about, as a question to the language server, when it can have
  // implementations: the declaration its usages are listed for, or the one its definition shows.
  // That's known once the declaration's file is in (the peek loads it).
  function peekSubject(p) {
    if (!CONFIG.served) return null;
    let q, name, at;
    if (p.uses) {
      if (p.uses.kind !== 'usages') return null;
      ({ q, name } = p.uses);
      at = { side: q.side, p: q.p, ext: q.ext, l: q.l, c: q.c };
    } else if (p.live) {
      if (p.live.status !== 'ok') return null;
      ({ q } = p.live);
      at = p.live.target;
      name = p.name || '';
    } else {
      if (p.ti == null || Number.isNaN(p.ti) || p.sel != null || !p.name) return null;
      const t = p.old ? DEFS_OLD[state.compare].targets[p.ti] : defsNow().targets[p.ti];
      if (!t) return null;
      q = { side: p.old ? 'base' : 'head', p: p.path, ext: null, l: p.old ? p.o : p.n, c: p.col };
      name = p.name;
      // A definition answered ahead keeps no column; one outside the repository is asked again.
      at = t.w === 'repo' ? { ...t, side: p.old ? 'base' : 'head', c: null } : p.resolved;
      if (!at) return null;
    }
    const s = at.side || at.ext != null ? loadSource({ side: at.side, path: at.p, ext: at.ext }, 'peek') : null;
    if (!s || s.status !== 'ok') return null;
    const line = s.lines[at.l - 1] || '';
    let col = at.c;
    if (col == null) {
      const m = new RegExp(`(^|[^\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).exec(line);
      col = m ? m.index + m[1].length : -1;
    }
    return implementable(s.lines, at.l, col) ? { q, name: name || nameIn(line, col) } : null;
  }
  // Whether the name at a column of a line (1-based) of a file declares what can be implemented:
  // a class or a mixin, or an instance member of one. Dart's formatter puts members one level in,
  // under the class at the margin, and locals deeper or under a function.
  function implementable(lines, l, col) {
    const line = lines[l - 1];
    if (line == null || col == null || col < 0) return false;
    const before = line.slice(0, col);
    if (/\b(?:class|mixin)\s+$/.test(before)) return true;
    if (!/^(?: {1,2}|\t)\S/.test(line)) return false;
    // Not a parameter, a static member, a factory or a constructor, which nothing overrides.
    const open = (before.match(/\(/g) || []).length - (before.match(/\)/g) || []).length;
    if (open > 0 || /\b(?:static|factory|const)\s/.test(before) || /\.\s*$/.test(before) || /^[A-Z]/.test(nameIn(line, col))) return false;
    for (let i = l - 2; i >= 0; i--) {
      // The declaration it's in: the nearest line above at the margin, past comments and annotations.
      if (!/^[^\s}/@*]/.test(lines[i])) continue;
      return /^(?:(?:abstract|sealed|base|interface|final)\s+)*(?:mixin\s+)?class\b|^(?:base\s+)?mixin\b/.test(lines[i]);
    }
    return false;
  }
  // The definition a peek shows, to tell whether a name in it leads back there.
  function shownTarget(p) {
    if (p.live) return p.live.status === 'ok' ? p.live.target : null;
    if (p.ti == null || Number.isNaN(p.ti) || p.sel != null) return null;
    const t = p.old ? DEFS_OLD[state.compare].targets[p.ti] : defsNow().targets[p.ti];
    return t ? { p: t.p, l: t.l, side: t.w === 'repo' ? (p.old ? 'base' : 'head') : null } : null;
  }
  const sameTarget = (a, b) => !!a && !!b && a.p === b.p && a.l === b.l && (a.side || null) === (b.side || null);
  function jumpToDefinition(q, el) {
    const view = state.view;
    el.classList.add('asking');
    askDefinition(q).then((live) => {
      el.classList.remove('asking');
      if (state.view !== view) return;
      if (live.status !== 'ok') return toast(live.status === 'none' ? 'No definition found for this name.' : live.error);
      const t = live.target;
      if (declares(q, t)) return showUsages(q, el);
      openSource({ side: t.side, p: t.side ? t.p : null, ext: t.ext, line: t.l, label: t.p, where: t.w });
    });
  }
  function liveLookup(el, jump) {
    const d = el.dataset;
    const q = { side: d.ls || null, p: d.lp || null, ext: d.lx !== '' && d.lx != null ? Number(d.lx) : null, l: Number(d.ll), c: Number(d.lc) };
    if (jump) return jumpToDefinition(q, el);
    const sameQ = (x) => x && x.side === q.side && x.p === q.p && x.ext === q.ext && x.l === q.l && x.c === q.c;
    if (el.closest('.peek') && state.peek) {
      // Asked from inside the peek: it stays as it is while the language server answers, then shows
      // the new definition in its place (Back returns), or stays when it already shows that one. A
      // name where it's declared shows its usages instead.
      const cur = state.peek;
      el.classList.add('asking');
      askDefinition(q).then((live) => {
        el.classList.remove('asking');
        if (state.peek !== cur) return;
        if (live.status !== 'ok') return toast(live.status === 'none' ? 'The language server knows no definition for this name.' : live.error);
        if (declares(q, live.target)) return cur.uses && cur.uses.kind === 'usages' && sameQ(cur.uses.q) ? undefined : showUsages(q, el);
        if (sameTarget(shownTarget(cur), live.target)) {
          const hit = main.querySelector(PEEK + ' .pk-ln.hit');
          if (hit) { hit.classList.remove('flash'); void hit.offsetWidth; hit.classList.add('flash'); }
          return;
        }
        state.peek = { ...anchorOf(cur), live, back: [...(cur.back || []), cur], name: nameOf(el) };
        updatePeek();
      });
      return;
    }
    const shown = state.peek && (state.peek.live || state.peek.uses);
    if (shown && sameQ(shown.q) && !(state.peek.back || []).length) { state.peek = null; return render(); }
    let peek;
    if (state.view.kind === 'source') peek = { src: { key: srcKey(state.view), line: q.l }, live: { q, status: 'loading' } };
    else if (q.side === 'base') peek = { old: true, path: q.p, o: q.l, col: q.c, live: { q, status: 'loading' } };
    else peek = { path: q.p, n: q.l, col: q.c, live: { q, status: 'loading' } };
    peek.name = nameOf(el);
    state.peek = peek;
    render();
    askDefinition(q).then((live) => {
      if (live.status === 'ok' && declares(q, live.target)) fillUsages(peek, q, el);
      else peek.live = live;
      if (state.peek === peek) updatePeek();
    });
  }

  // ---------- GitHub: the pull request's conversation
  // Review threads show under the lines they're on, the Comments tab lists them with the
  // conversation, and the review is finished from the top bar. untangle asks GitHub through gh,
  // as the user. What's written waits as a draft (kept in this browser) until it's sent.
  const GH = {
    on: !!(CONFIG.served && CONFIG.github && !CONFIG.github.off),
    data: null, sig: '', error: null, loading: false, at: 0, stale: false,
    anchors: new Map(), files: new Map(),
    busy: null, errors: new Map(), focus: null, reveal: null,
    opened: new Set(), replying: new Set(), editing: null, picker: null, previews: new Map(), preview: new Set(),
    showResolved: false, away: new Set(), fileCompose: null, reviewOpen: false, event: 'COMMENT',
    // Comment ids GitHub has given so far, and the ones new in its last answer (they fade in).
    known: null, fresh: new Set(),
  };
  const DRAFTS = 'untangle:drafts:' + ((CONFIG.github && CONFIG.github.url) || CONFIG.key || 'review');
  const drafts = new Map();
  try { Object.entries(JSON.parse(localStorage.getItem(DRAFTS) || '{}')).forEach(([k, v]) => { if (typeof v === 'string') drafts.set(k, v); }); } catch (e) { /* storage unavailable */ }
  let draftTimer = null;
  const writeDrafts = () => { try { localStorage.setItem(DRAFTS, JSON.stringify(Object.fromEntries(drafts))); } catch (e) { /* storage unavailable */ } };
  function setDraft(key, text) {
    if (text) drafts.set(key, text); else drafts.delete(key);
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { draftTimer = null; writeDrafts(); }, 300);
  }
  // A write still waiting when the page goes away happens now: the last keys typed stay, and a
  // comment just sent doesn't come back after a reload.
  const flushDrafts = () => { if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; writeDrafts(); } };
  window.addEventListener('pagehide', flushDrafts);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDrafts(); });
  // ---------- Notes: comments kept on this machine, for a coding agent, instead of on GitHub.
  // untangle keeps them for the review and moves each with its lines to newer commits. An agent
  // reads them with `untangle watch` and answers in their threads with `untangle reply`; the
  // Review button's menu says where new comments go, and copies the notes as a prompt.
  const NT = {
    on: !!CONFIG.served,
    data: null, error: null, loading: false, again: false, busy: null, errors: new Map(),
    anchors: new Map(), files: new Map(), byN: new Map(),
    opened: new Set(), replying: new Set(), editing: null, folded: new Set(), was: new Set(), showResolved: false,
    reveal: null, opening: null, openingTimer: null, seenAgents: new Set(), agentOpen: null,
  };
  // GitHub can take comments: the review has a pull request, and gh answered (or hasn't yet).
  const ghCan = () => GH.on && !(GH.error && !GH.data);
  // Where new comments go: local notes where GitHub can't take them, else the review's last
  // choice, GitHub at first.
  const localMode = () => NT.on && (!ghCan() || (!!NT.data && NT.data.mode === 'local'));
  // Whether lines can take new comments: a note anywhere; on GitHub, on its head, which must be this review's.
  const canCommentLines = () => (localMode() ? !!NT.data : GH.on && GH.data && !GH.stale && !GH.data.pr.locked);
  // Whether notes can go to GitHub now: as threads on its head, which must be this review's.
  const canPost = () => ghCan() && !!GH.data && !GH.stale && !GH.data.pr.locked;
  const okJson = (r) => r.json().catch(() => ({ error: r.statusText })).then((j) => { if (!r.ok) throw new Error(j.error || r.status); return j; });
  // The agents holding the review, and where each one's chat is: listening, working on notes, a
  // line from untangle waiting for its turn, not listening (deaf), or gone (left).
  const agentsNow = () => (NT.data ? NT.data.agents : []);
  // The one a note just written goes to: the first that hears it, else the first.
  const agentFirst = () => { const l = agentsNow(); return l.find((a) => a.state !== 'deaf' && a.state !== 'left') || l[0] || null; };

  function ntSet(d) {
    const was = NT.data;
    NT.data = d;
    NT.anchors = new Map(); NT.files = new Map(); NT.byN = new Map();
    const fileOf = (p) => { if (!NT.files.has(p)) NT.files.set(p, { line: [], file: [], away: [], open: 0 }); return NT.files.get(p); };
    const m = M('base');
    const generated = new Set(m.generated.map((g) => g.p));
    d.notes.forEach((n) => {
      NT.byN.set(n.n, n);
      const e = fileOf(n.path);
      if (!n.resolved) e.open++;
      if (n.file) { e.file.push(n); return; }
      // A note shows under its line when this review's diff has the line; else with its file.
      const inDiff = !n.gone && n.line != null && (generated.has(n.path) || (n.side === 'LEFT' ? m.old : m.head).has(n.path + ':' + n.line));
      if (!inDiff) { e.away.push(n); return; }
      const k = n.path + '\n' + n.side + '\n' + n.line;
      if (!NT.anchors.has(k)) NT.anchors.set(k, []);
      NT.anchors.get(k).push(n);
      e.line.push(n);
    });
    if (NT.opening == null || !NT.openingTimer) NT.opening = d.opening;
    // What an agent did since the page last looked: its answers fade in, and it's said once.
    const news = [];
    if (was) {
      const before = new Map(was.notes.map((n) => [n.n, n]));
      // An agent's own notes, from its review of the change, and its answers in threads.
      const wrote = [];
      d.notes.forEach((n) => {
        const b = before.get(n.n);
        const answers = n.comments.filter((c) => c.by && !(b && b.comments.some((x) => x.id === c.id)));
        answers.forEach((c) => GH.fresh.add(c.id));
        if (!b && n.comments[0].by) wrote.push(n);
        else if (answers.length) news.push(`${answers[0].by} answered N${n.n}`);
        if (n.resolved && n.resolved.by && !(b && b.resolved)) news.push(`${n.resolved.by} resolved N${n.n}`);
      });
      if (wrote.length) news.unshift(`${wrote[0].comments[0].by} wrote ${nList(wrote.map((n) => n.n))}`);
    }
    // Where each agent's chat went since: it began listening, another chat took over, it left, or
    // a line from untangle waits while it's busy.
    const before = new Map((was ? was.agents : []).map((a) => [a.name, a]));
    d.agents.forEach((a) => {
      const b = before.get(a.name);
      if (!NT.seenAgents.has(a.name)) { NT.seenAgents.add(a.name); if (was && a.state === 'listening') news.push(`${a.name} is listening`); return; }
      if (!b) return;
      if (b.chat && a.chat && b.chat !== a.chat) news.push(`A new ${a.name} chat took over this review`);
      else if (a.state === 'left' && b.state !== 'left') news.push(`${a.name} left: its chat ended`);
      else if (a.state === 'queued' && b.state !== 'queued' && a.kind === 'codex' && a.busy) news.push(`Queued for ${a.name}: it’s busy`);
    });
    if (news.length) toast(news.slice(0, 3).join(' · '));
  }
  function ntLoad() {
    if (!NT.on) return;
    if (NT.loading) { NT.again = true; return; }
    NT.loading = true;
    api('notes', { cache: 'no-store' }).then(okJson)
      .then((j) => { NT.error = null; if (!NT.data || j.rev !== NT.data.rev) { ntSet(j); render(); } })
      .catch((e) => { NT.error = e.message; render(); })
      .then(() => { NT.loading = false; if (NT.again) { NT.again = false; ntLoad(); } });
  }
  // A change to the notes: the answer is the notes after it (and, posted, GitHub's conversation).
  function ntAct(key, payload, done) {
    if (NT.busy) return;
    NT.busy = key;
    NT.errors.delete(key);
    render();
    api('notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).then(okJson)
      .then((j) => { if (j.conversation) { GH.at = Date.now(); ghSet(j.conversation); } ntSet(j); if (done) done(j); })
      .catch((e) => { NT.errors.set(key, e.message); ntLoad(); if (/post/.test(key)) ghLoad(true); })
      .then(() => { NT.busy = null; render(); });
  }
  // The menu's settings: shown at once, then kept.
  function ntSettings(patch) {
    if (!NT.data) return;
    Object.assign(NT.data, patch);
    render();
    api('notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'settings', ...patch }) }).then(okJson)
      .then((j) => { ntSet(j); render(); })
      .catch((e) => { toast(`Couldn’t save: ${e.message}`); ntLoad(); });
  }
  const ntBusyAttr = (key) => (NT.busy ? ` disabled${NT.busy === key ? ' aria-busy="true"' : ''}` : '');

  // A note's text, as markdown: paragraphs, lists, quotes, code, emphasis and links. Rendered
  // here: GitHub doesn't see notes.
  function noteMd(text) {
    const inline = (str) => String(str).split(/(`[^`]+`)/).map((part, i) => (i % 2 ? `<code>${esc(part.slice(1, -1))}</code>` : esc(part)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'))).join('');
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    let out = '', para = [], list = null;
    const flush = () => {
      if (para.length) { out += `<p>${para.map(inline).join('<br>')}</p>`; para = []; }
      if (list) { out += `<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`; list = null; }
    };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const f = /^\s*(`{3,}|~{3,})/.exec(l);
      if (f) {
        flush();
        const code = [];
        for (i++; i < lines.length && !(lines[i].trim().startsWith(f[1]) && /^\s*[`~]+\s*$/.test(lines[i])); i++) code.push(lines[i]);
        out += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
        continue;
      }
      if (!l.trim()) { flush(); continue; }
      if (/^\s*>/.test(l)) {
        flush();
        const quote = [];
        for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i--;
        out += `<blockquote>${noteMd(quote.join('\n'))}</blockquote>`;
        continue;
      }
      const li = /^\s*(?:([-*+])|\d+[.)])\s+(.*)$/.exec(l);
      if (li) {
        const tag = li[1] ? 'ul' : 'ol';
        if (para.length || (list && list.tag !== tag)) flush();
        if (!list) list = { tag, items: [] };
        list.items.push(li[2]);
        continue;
      }
      if (list) flush();
      para.push(l);
    }
    flush();
    return out;
  }
  // Text on the clipboard: from the click itself, else through a selection.
  function copyText(text, said) {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { /* refused */ }
      ta.remove();
      toast(ok ? said : 'The browser refused the clipboard: select the text and copy it.');
      return ok;
    };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => { toast(said); return true; }, fallback);
    return Promise.resolve(fallback());
  }
  // The copy for the agent: the head, the opening line, then each note, as untangle notes prints it.
  function ntExport(list) {
    const d = NT.data;
    const opening = (NT.opening != null ? NT.opening : d.opening).trim();
    return [d.header + '\n', opening && opening + '\n', ...(list.length ? list.map((n) => n.text) : ['No notes to send.\n'])].filter(Boolean).join('\n');
  }
  const ntScoped = (scope) => { const d = NT.data; return !d ? [] : scope === 'all' ? d.notes : d.notes.filter((n) => !n.resolved && (scope !== 'new' || !n.copied)); };

  function ghSet(d) {
    const ids = d.threads.flatMap((t) => t.comments.map((c) => c.id)).concat(d.comments.map((c) => c.id));
    if (GH.known) ids.forEach((id) => { if (!GH.known.has(id)) GH.fresh.add(id); });
    GH.known = new Set(ids);
    GH.data = d;
    GH.sig = JSON.stringify(d);
    GH.stale = d.pr.head !== CONFIG.head;
    GH.anchors = new Map();
    GH.files = new Map();
    const fileOf = (p) => { if (!GH.files.has(p)) GH.files.set(p, { line: [], file: [], away: [], open: 0 }); return GH.files.get(p); };
    d.threads.forEach((t) => {
      const e = fileOf(t.path);
      if (!t.resolved) e.open++;
      t.at = null;
      if (t.file) { e.file.push(t); return; }
      // GitHub gives a thread's lines on the pull request's head; when that's newer than this
      // review, a thread written on this review's commit keeps its original lines.
      const line = t.outdated ? null : !GH.stale ? t.line : t.commit === CONFIG.head ? t.originalLine : null;
      if (line == null) { e.away.push(t); return; }
      t.at = line;
      t.from = !GH.stale ? t.startLine : t.originalStartLine;
      const k = t.path + '\n' + t.side + '\n' + line;
      if (!GH.anchors.has(k)) GH.anchors.set(k, []);
      GH.anchors.get(k).push(t);
      e.line.push(t);
    });
  }
  function ghLoad(quiet) {
    if (!GH.on || GH.loading) return;
    GH.loading = true;
    if (!quiet) render();
    api('github', { cache: 'no-store' })
      .then((r) => r.json().catch(() => ({ error: r.statusText })).then((j) => { if (!r.ok) throw new Error(j.error || r.status); return j; }))
      .then((j) => {
        GH.loading = false; GH.error = null; GH.at = Date.now();
        // Polled: the page changes only when the conversation did.
        if (JSON.stringify(j) !== GH.sig) { ghSet(j); render(); } else if (!quiet) render();
        if (GH.stale) freshCheck();
      })
      .catch((e) => { GH.loading = false; GH.error = e.message; GH.at = Date.now(); render(); });
  }
  // A change on GitHub: the answer is the conversation after it. `done` runs when it worked.
  function ghAct(key, payload, done) {
    if (GH.busy) return;
    GH.busy = key;
    GH.errors.delete(key);
    render();
    api('github', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then((r) => r.json().catch(() => ({ error: r.statusText })).then((j) => { if (!r.ok) throw new Error(j.error || r.status); return j; }))
      .then((j) => { GH.at = Date.now(); ghSet(j); if (done) done(); })
      .catch((e) => { GH.errors.set(key, e.message); ghLoad(true); })
      .then(() => { GH.busy = null; render(); });
  }
  function ghPreview(key) {
    const text = drafts.get(key) || '';
    const p = GH.previews.get(key);
    if (p && p.text === text) return;
    const entry = { text, html: null, error: null };
    GH.previews.set(key, entry);
    if (!text.trim()) { entry.html = '<p class="muted">Nothing to preview.</p>'; return; }
    api('github', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'preview', text }) })
      .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.status); return j; }))
      .then((j) => { entry.html = j.html; })
      .catch((e) => { entry.error = e.message; })
      .then(() => { if (GH.previews.get(key) === entry) render(); });
  }

  // GitHub's rendered markdown, cleaned once more here: only content stays (no scripts, styles,
  // handlers or frames), and links open GitHub in a new tab.
  const KEEP_TAGS = new Set('a abbr b blockquote br code dd del details div dl dt em g-emoji h1 h2 h3 h4 h5 h6 hr i img input ins kbd li ol p picture pre q s samp source span strike strong sub summary sup table tbody td tfoot th thead tr tt ul video'.split(' '));
  const DROP_TAGS = new Set('script style iframe frame frameset object embed form link meta base template noscript textarea select button svg math'.split(' '));
  const KEEP_ATTRS = new Set('href src srcset alt title width height align colspan rowspan open type checked disabled lang dir class media controls poster start data-line-number'.split(' '));
  const cleanCache = new Map();
  function clean(html) {
    if (cleanCache.has(html)) return cleanCache.get(html);
    const tpl = document.createElement('template');
    tpl.innerHTML = html || '';
    const walk = (node) => {
      [...node.childNodes].forEach((el) => {
        if (el.nodeType === 8) { el.remove(); return; }
        if (el.nodeType !== 1) return;
        const tag = el.localName;
        if (DROP_TAGS.has(tag)) { el.remove(); return; }
        walk(el);
        if (!KEEP_TAGS.has(tag)) { el.replaceWith(...el.childNodes); return; }
        [...el.attributes].forEach((a) => {
          const n = a.name.toLowerCase(), v = a.value.trim();
          if (!KEEP_ATTRS.has(n) || ((n === 'href' || n === 'src' || n === 'poster') && !/^(https?:|mailto:|#)/i.test(v)) || (n === 'srcset' && /(javascript|data|vbscript):/i.test(v))) el.removeAttribute(a.name);
          // GitHub's highlighting classes stay; the page's own can't be borrowed.
          if (n === 'class') { const keep = v.split(/\s+/).filter((c) => /^(pl-|blob-|js-suggested-changes-blob$|highlight|user-mention|team-mention|issue-link|commit-link|task-list|contains-task-list|markdown-)/.test(c)); if (keep.length) el.setAttribute('class', keep.join(' ')); else el.removeAttribute('class'); }
        });
        if (tag === 'input') { if (el.getAttribute('type') !== 'checkbox') { el.remove(); return; } el.setAttribute('disabled', ''); }
        if (tag === 'a' && /^https?:/i.test(el.getAttribute('href') || '')) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
        if (tag === 'img') el.setAttribute('loading', 'lazy');
      });
    };
    walk(tpl.content);
    if (cleanCache.size > 500) cleanCache.clear();
    cleanCache.set(html, tpl.innerHTML);
    return tpl.innerHTML;
  }
  function ago(iso) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 2 * 86400) return 'yesterday';
    if (s < 30 * 86400) return `${Math.floor(s / 86400)} days ago`;
    return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  const avatar = (p, size) => p.avatar ? `<img class="av" src="${esc(p.avatar + (p.avatar.includes('?') ? '&' : '?') + 's=' + (size || 56))}" alt="" loading="lazy">` : '<span class="av"></span>';
  const ROLE = { OWNER: 'Owner', MEMBER: 'Member', COLLABORATOR: 'Collaborator', CONTRIBUTOR: 'Contributor' };
  const EMOJI = { THUMBS_UP: '👍', THUMBS_DOWN: '👎', LAUGH: '😄', HOORAY: '🎉', CONFUSED: '😕', HEART: '❤️', ROCKET: '🚀', EYES: '👀' };
  const busyAttr = (key) => (GH.busy ? ` disabled${GH.busy === key ? ' aria-busy="true"' : ''}` : '');
  // Where a comment box sends: kept here as a note (and to a watching agent), or posted to GitHub.
  function destHtml(local) {
    if (!local) return '<span class="cmp-dest"><i></i><b>Posts to GitHub</b></span>';
    const a = agentFirst(), live = !NT.data || NT.data.live;
    return `<span class="cmp-dest local"><i></i><b>Saved locally${!live ? ', held until you send it' : a && a.state !== 'deaf' && a.state !== 'left' ? `, sent to ${esc(a.name)}` : ''}</b></span>`;
  }
  // A box's switch between a note for your agent and a comment on GitHub: the Review menu's, at
  // hand. It sets where new comments go, this one too; what's written stays.
  function modeSwitchHtml(local, key) {
    const why = `GitHub didn’t answer: ${GH.error || ''}`;
    return `<span class="mini-seg cmp-mode" role="group" aria-label="Note or comment">`
      + `<button type="button" data-act="nt-mode" data-mode="local" data-key="${esc(key)}" aria-pressed="${local}" title="A note for your agent, kept on this machine"><i class="sw"></i>Note</button>`
      + `<button type="button" data-act="nt-mode" data-mode="github" data-key="${esc(key)}" aria-pressed="${!local}" title="${ghCan() ? 'A comment on the pull request, on GitHub' : esc(why)}"${ghCan() ? '' : ' disabled'}><i class="sw gh"></i>Comment</button></span>`;
  }
  // A text box for writing grows with what's in it, up to most of the window, and scrolls past that.
  function fitBox(ta) {
    const keep = main.scrollTop, max = Math.round(innerHeight * 0.6);
    ta.style.height = 'auto';
    const want = ta.scrollHeight;
    ta.style.height = `${Math.min(want, max)}px`;
    ta.style.overflowY = want > max ? 'auto' : 'hidden';
    if (main.scrollTop !== keep) main.scrollTop = keep;
  }
  const fitBoxes = (el) => el.querySelectorAll('.cmp-ta, .rv-ta').forEach(fitBox);
  // A text box for markdown: Write and Preview, an error, and its buttons ([label, attrs, primary]).
  // A note's (o.local) previews here and sends to untangle; o.dest says where it sends, and o.mode
  // switches it between a note and a comment when the review has both.
  function composerHtml(key, o) {
    const B = o.local ? NT : GH;
    const previewing = GH.preview.has(key);
    const p = previewing && !o.local ? GH.previews.get(key) : null;
    const err = B.errors.get(key);
    const busy = (k) => (B.busy ? ` disabled${B.busy === k ? ' aria-busy="true"' : ''}` : '');
    const btns = o.buttons.map(([label, attrs, primary]) => `<button type="button" class="btn sm${primary ? ' primary' : ''}" ${attrs} data-key="${esc(key)}"${primary ? ' data-primary="1"' : ''}${busy(key)}>${B.busy === key && primary ? (o.local ? 'Saving…' : 'Sending…') : label}</button>`).join('');
    const pane = `data-act="cmp-pane" data-key="${esc(key)}"${o.local ? ' data-local="1"' : ''}`;
    const pre = o.local ? (noteMd(drafts.get(key) || '') || '<p class="muted">Nothing to preview.</p>') : p && p.html != null ? clean(p.html) : p && p.error ? `<p class="cmp-err">${esc(p.error)}</p>` : '<p class="muted">Rendering…</p>';
    return `<div class="cmp${o.local ? ' local' : ''}" data-cmp="${esc(key)}"><div class="cmp-tabs"><button type="button" ${pane} data-pane="write" aria-pressed="${!previewing}">Write</button><button type="button" ${pane} data-pane="preview" aria-pressed="${previewing}">Preview</button><span class="sp"></span>`
      + (o.mode && NT.on && GH.on && NT.data ? modeSwitchHtml(o.local, key) : '')
      + (o.suggest ? iconBtn(ICON.suggest, 'Suggest a change: the lines, to edit into what they should be', `data-act="cmp-suggest" data-key="${esc(key)}"`) : '') + '</div>'
      + (previewing ? `<div class="cmp-pre cm-body">${pre}</div>`
        : `<textarea class="cmp-ta" data-draft="${esc(key)}" placeholder="${esc(o.placeholder || (o.local ? 'A note for your agent' : 'Leave a comment'))}" rows="${o.rows || 4}">${esc(drafts.get(key) || '')}</textarea>`)
      + (err ? `<div class="cmp-err" role="alert">${esc(err)}</div>` : '') + (o.extra || '')
      + `<div class="cmp-f"><span class="cmp-hint">${o.dest ? destHtml(o.local) + ' · ' : ''}Markdown<span class="cmp-key"> · Ctrl+Enter: ${esc(o.buttons.find((b) => b[2])[0])}</span></span><span class="sp"></span>${o.cancel ? `<button type="button" class="btn sm" data-act="${o.cancel}" data-key="${esc(key)}"${busy(key)}>Cancel</button>` : ''}${btns}</div></div>`;
  }
  // The buttons to send a comment: into the pending review, or (with none pending) on its own. In
  // local mode, one: Add note (on a GitHub thread, a note that quotes it).
  function sendButtons(act, attrs) {
    if (localMode()) return [['Add note', `data-act="${act === 'gh-reply' ? 'nt-quote' : 'nt-add'}" ${attrs || ''}`, true]];
    if (GH.data && GH.data.pending) return [['Add review comment', `data-act="${act}" data-mode="review" ${attrs || ''}`, true]];
    return [['Add single comment', `data-act="${act}" data-mode="single" ${attrs || ''}`, false], ['Start a review', `data-act="${act}" data-mode="review" ${attrs || ''}`, true]];
  }
  function reactionsHtml(c) {
    const chips = c.reactions.map((r) => `<button type="button" class="rx${r.mine ? ' on' : ''}" data-act="gh-react" data-subject="${esc(c.id)}" data-content="${r.content}" data-on="${!r.mine}" title="${esc(r.content.toLowerCase().replace('_', ' '))}"${c.canReact ? '' : ' disabled'}>${EMOJI[r.content] || r.content} ${r.count}</button>`).join('');
    const picker = GH.picker === c.id ? `<span class="rx-pick" role="group" aria-label="Reactions">${Object.entries(EMOJI).map(([k, e]) => { const mine = c.reactions.some((r) => r.content === k && r.mine); return `<button type="button" class="rx${mine ? ' on' : ''}" data-act="gh-react" data-subject="${esc(c.id)}" data-content="${k}" data-on="${!mine}" title="${esc(k.toLowerCase().replace('_', ' '))}">${e}</button>`; }).join('')}</span>` : '';
    return chips || picker ? `<div class="cm-rx">${chips}${picker}</div>` : '';
  }
  // A comment: kind 'review' (in a thread), 'issue' (the conversation) or 'pr' (the description).
  // `first`: it starts a run of comments by one author, so it says who wrote it; the others in the
  // run show only their time. Its tools show under the pointer.
  // On a touch screen, with no pointer, they're behind a ⋯ instead, as a menu.
  const cmMoreHtml = (key) => `<button type="button" class="ib cm-more" data-act="menu" data-menu="cm:${esc(key)}" aria-haspopup="menu" aria-expanded="${MENU.open === 'cm:' + key}" title="More" aria-label="More">${ICON.more}</button>`;
  function commentHtml(c, kind, first) {
    const editKey = 'edit:' + c.id;
    const tools = (c.canReact ? iconBtn(ICON.smiley, 'React', `data-act="react-open" data-subject="${esc(c.id)}"`) : '')
      + (c.canEdit && kind !== 'pr' ? iconBtn(ICON.edit, 'Edit', `data-act="edit-open" data-id="${esc(c.id)}"`) : '')
      + (c.canDelete && kind !== 'pr' ? iconBtn(ICON.trash, 'Delete', `data-act="gh-delete" data-id="${esc(c.id)}" data-kind="${kind}"${busyAttr('del:' + c.id)}`) : '')
      + (c.url ? `<a class="ib" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer" title="Open on GitHub" aria-label="Open on GitHub">${ICON.external}</a>` : '');
    const body = GH.editing === c.id
      ? composerHtml(editKey, { buttons: [['Update comment', `data-act="gh-edit" data-id="${esc(c.id)}" data-kind="${kind}"`, true]], cancel: 'edit-cancel' })
      : `<div class="cm-body">${c.html ? clean(c.html) : '<p class="muted">No description.</p>'}</div>`;
    const err = GH.errors.get('del:' + c.id);
    const when = `<span title="${esc(new Date(c.created).toLocaleString())}">${ago(c.created)}${c.edited ? ' · edited' : ''}</span>`;
    // A role shows only for the pull request's author.
    const author = kind !== 'pr' && GH.data && GH.data.pr.author && c.author.login === GH.data.pr.author.login ? '<span class="cm-tag">Author</span>' : '';
    const pending = c.pending ? '<span class="cm-tag pending">Pending</span>' : '';
    const head = first ? `<div class="cm-h"><a class="cm-who" href="${esc(c.author.url)}" target="_blank" rel="noopener noreferrer">${esc(c.author.login)}</a>${author}${when}${pending}</div>` : '';
    return `<div class="cm${first ? ' first' : ''}${c.pending ? ' pending' : ''}" data-comment="${esc(c.id)}">${first ? avatar(c.author) : '<span></span>'}<div class="cm-main">${head}${!first && c.pending ? pending : ''}${body}${err ? `<div class="cmp-err" role="alert">${esc(err)}</div>` : ''}${reactionsHtml(c)}</div>${first ? '' : `<span class="cm-t">${when}</span>`}${tools ? `<span class="cm-tools">${tools}</span>${cmMoreHtml('gh:' + c.id)}` : ''}</div>`;
  }
  // A review thread, under its line: one quiet block with GitHub's blue on its edge. Resolved
  // threads fold, as on GitHub.
  function threadHtml(t, o) {
    o = o || {};
    const open = !t.resolved || GH.opened.has(t.id);
    const n = t.comments.length;
    const pending = t.comments.some((c) => c.pending);
    const lines = t.file ? '' : t.at != null && t.from != null && t.from !== t.at ? `lines ${t.from} to ${t.at}` : t.at != null ? `line ${t.at}` : `line ${t.originalLine}`;
    let h = `<div class="th${t.resolved ? ' resolved' : ''}${pending ? ' pending' : ''}" data-thread="${esc(t.id)}">`;
    if (t.resolved || o.head) {
      h += `<button type="button" class="th-fold" data-act="thread-toggle" data-thread="${esc(t.id)}" aria-expanded="${open}"><span class="tw">${open ? ICON.chevronDown : ICON.chevronRight}</span>${t.resolved ? `${ICON.check}<span>Resolved${t.resolvedBy ? ` by ${esc(t.resolvedBy)}` : ''}</span>` : ''}${o.head ? `<span>${o.head}</span>` : ''}<span class="muted">· ${lines ? `${esc(lines)} · ` : ''}${n} comment${n === 1 ? '' : 's'}</span></button>`;
    }
    if (!open) return h + '</div>';
    if (t.outdated && !o.head) h += '<div class="th-note">Outdated: the code changed since.</div>';
    let prev = null;
    h += t.comments.map((c) => { const first = !prev || prev.author.login !== c.author.login; prev = c; return commentHtml(c, 'review', first); }).join('');
    const key = 'reply:' + t.id, err = GH.errors.get('resolve:' + t.id);
    const res = t.resolved ? (t.canUnresolve ? 'Unresolve' : '') : t.canResolve ? 'Resolve' : '';
    const resBtn = res ? `<button type="button" class="btn" data-act="gh-resolve" data-thread="${esc(t.id)}" data-on="${!t.resolved}" title="${t.resolved ? 'Open the conversation again' : 'Resolve the conversation'}"${busyAttr('resolve:' + t.id)}>${GH.busy === 'resolve:' + t.id ? 'Saving…' : res}</button>` : '';
    const reply = GH.replying.has(t.id) || drafts.has(key) ? composerHtml(key, { local: localMode(), dest: true, mode: true, placeholder: localMode() ? 'A note on this thread, for your agent' : 'Reply…', rows: 3, buttons: sendButtons('gh-reply', `data-thread="${esc(t.id)}"`), cancel: 'reply-cancel' })
      : t.canReply ? `<button type="button" class="th-reply" data-act="reply-open" data-thread="${esc(t.id)}">Reply…</button>` : '';
    if (reply || resBtn || err) h += `<div class="th-f">${reply}${resBtn}${err ? `<div class="cmp-err" role="alert">${esc(err)}</div>` : ''}</div>`;
    return h + '</div>';
  }
  // The composer for a new thread, under the last of its lines.
  function newThreadHtml(c) {
    const sign = (side) => (side === 'LEFT' ? '−' : '+');
    const what = c.startLine != null && (c.startLine !== c.line || c.startSide !== c.side) ? `lines ${sign(c.startSide)}${c.startLine} to ${sign(c.side)}${c.line}` : `line ${sign(c.side)}${c.line}`;
    const local = localMode();
    return `<div class="th new${local ? ' note' : ''}" data-thread="new"><div class="th-new-h">${ICON.comment}<b>${local ? 'Note' : 'Comment'} on ${what}</b><span class="muted">${COARSE.matches ? 'Tap another line’s gutter in this hunk for a range.' : 'Drag the + over more lines, or shift-click it on another line of this hunk, for a range.'}</span></div>`
      + composerHtml(c.key, { local, dest: true, mode: true, buttons: sendButtons('gh-thread'), cancel: 'compose-cancel', suggest: c.hi != null && c.side === 'RIGHT' && (c.startSide == null || c.startSide === 'RIGHT') }) + '</div>';
  }
  // Threads and notes on a side's line of a file, and the comment being written there.
  function threadsAt(f, side, line) {
    if (line == null) return '';
    const k = f.p + '\n' + side + '\n' + line;
    const list = GH.on && GH.data ? GH.anchors.get(k) : null, notes = NT.data ? NT.anchors.get(k) : null;
    let h = (list ? list.map((t) => threadHtml(t)).join('') : '') + (notes ? notes.map((n) => noteHtml(n)).join('') : '');
    const c = state.compose;
    if (c && !compact() && c.path === f.p && c.side === side && c.line === line) h += newThreadHtml(c);
    return h;
  }
  // Threads under a unified row: on its new line, and on its old one (a removed or unchanged line).
  function threadsRow(f, meta, noLeft) {
    if (!(GH.on && GH.data) && !NT.data && !state.compose) return '';
    return (meta.t !== '-' ? threadsAt(f, 'RIGHT', meta.n) : '') + (!noLeft && meta.t !== '+' && meta.o != null ? threadsAt(f, 'LEFT', meta.o) : '');
  }
  // Whether a row of a hunk is in the range a comment is being written on.
  const inCompose = (f, hi, ri) => { const c = state.compose; return !!c && c.path === f.p && c.hi === hi && ri >= c.r0 && ri <= c.r1; };
  // The rows each open thread and note is on, by hunk and row as the composer's range: they get a
  // bar in the gutter, a tint while you point at the comment or its bar, and a click back to it.
  // Built once a render. Per file: the ranges, and the comments under each line ('R:12', 'L:9').
  let MARKS = null;
  function marks() {
    if (MARKS) return MARKS;
    MARKS = { byPath: new Map(), byId: new Map() };
    const m = M();
    const at = (path, side, line) => (line == null ? null : (side === 'LEFT' ? m.old : m.head).get(path + ':' + line) || null);
    const put = (id, kind, path, from, to) => {
      const b = at(path, to.side, to.line);
      if (!b) return;
      const a = (from && at(path, from.side, from.line)) || b;
      const [r0, r1] = a.hi === b.hi ? [Math.min(a.ri, b.ri), Math.max(a.ri, b.ri)] : [b.ri, b.ri];
      const keys = [];
      for (let ri = r0; ri <= r1; ri++) {
        const r = b.f.hunks[b.hi].meta[ri];
        if (r.n != null) keys.push('R:' + r.n);
        if (r.o != null && r.t !== '+') keys.push('L:' + r.o);
      }
      if (!MARKS.byPath.has(path)) MARKS.byPath.set(path, { ranges: [], byKey: new Map() });
      const p = MARKS.byPath.get(path);
      p.ranges.push({ hi: b.hi, r0, r1, kind });
      keys.forEach((k) => { if (!p.byKey.has(k)) p.byKey.set(k, []); p.byKey.get(k).push(id); });
      MARKS.byId.set(id, { path, kind, keys });
    };
    if (GH.on && GH.data) GH.data.threads.forEach((t) => { if (!t.resolved && !t.file && t.at != null) put('gh:' + t.id, 'gh', t.path, t.from != null ? { side: t.startSide || t.side, line: t.from } : null, { side: t.side, line: t.at }); });
    if (NT.data) NT.data.notes.forEach((n) => { if (!n.resolved && !n.file && !n.gone && n.line != null) put('nt:' + n.n, 'nt', n.path, n.startLine != null ? { side: n.startSide || n.side, line: n.startLine } : null, { side: n.side, line: n.line }); });
    return MARKS;
  }
  // A row's marks: ' cm-on' under an open thread, ' nt-on' under an open note (a split row: either side's).
  function markAt(f, hi, ...ris) {
    const p = marks().byPath.get(f.p);
    if (!p) return '';
    let gh = false, nt = false;
    p.ranges.forEach((r) => { if (r.hi === hi && ris.some((ri) => ri != null && ri >= r.r0 && ri <= r.r1)) { if (r.kind === 'gh') gh = true; else nt = true; } });
    return (gh ? ' cm-on' : '') + (nt ? ' nt-on' : '');
  }
  // Comments and notes on a file (not a line), threads and notes whose line isn't in this version,
  // and a new file comment.
  function fileThreadsHtml(f) {
    const e = (GH.on && GH.data && GH.files.get(f.p)) || { file: [], away: [] };
    const nt = (NT.data && NT.files.get(f.p)) || { file: [], away: [] };
    let h = '';
    if (GH.fileCompose === f.p) {
      const key = 'file:' + f.p, local = localMode();
      h += `<div class="th new${local ? ' note' : ''}" data-thread="new"><div class="th-new-h">${ICON.comment}<b>${local ? 'Note' : 'Comment'} on the file</b></div>${composerHtml(key, { local, dest: true, mode: true, buttons: sendButtons('gh-thread', 'data-file="1"'), cancel: 'file-cancel' })}</div>`;
    }
    h += e.file.map((t) => threadHtml(t, { head: '<b>On the file</b>' })).join('');
    h += nt.file.map((n) => noteHtml(n, { head: '<b>On the file</b>' })).join('');
    if (e.away.length) {
      const open = GH.away.has(f.p);
      h += `<button type="button" class="th-away" data-act="away-toggle" data-p="${esc(f.p)}" aria-expanded="${open}"><span class="tw">${open ? ICON.chevronDown : ICON.chevronRight}</span>${e.away.length} thread${e.away.length > 1 ? 's' : ''} on code this version doesn’t have (outdated${GH.stale ? ', or on newer commits' : ''})</button>`;
      if (open) h += e.away.map((t) => hunkSnippet(t) + threadHtml(t, { head: `<b>${t.outdated ? 'Outdated' : 'On a newer commit'}</b>` })).join('');
    }
    // Notes whose lines went, or left the diff, stay open here until folded.
    if (nt.away.length) {
      const open = !NT.folded.has(f.p);
      h += `<button type="button" class="th-away note" data-act="nt-away" data-p="${esc(f.p)}" aria-expanded="${open}"><span class="tw">${open ? ICON.chevronDown : ICON.chevronRight}</span>${nt.away.length} note${nt.away.length > 1 ? 's' : ''} on code this version doesn’t show</button>`;
      if (open) h += nt.away.map((n) => noteSnippet(n) + noteHtml(n, { head: n.gone ? `<b>Gone since <code>${esc(shortSha(n.wrote.head))}</code></b>` : `<b>${esc(noteLines(n))}, outside the diff</b>` })).join('');
    }
    return h ? `<div class="fthreads">${h}</div>` : '';
  }
  // The end of the diff hunk a thread was written on, for a thread that has no line here.
  function hunkSnippet(t) {
    if (!t.hunk) return '';
    const lines = t.hunk.split('\n').slice(1).slice(-5);
    return `<div class="th-hunk">${lines.map((l) => `<div class="${l[0] === '+' ? 'a' : l[0] === '-' ? 'd' : ''}">${esc(l)}</div>`).join('')}</div>`;
  }
  // A note's lines, as a thread's are said: line 28, lines 47 to 49, line −12 (the base's).
  function noteLines(n) {
    if (n.file) return 'the file';
    const sign = n.side === 'LEFT' ? '−' : '';
    return n.startLine != null && n.startLine !== n.line ? `lines ${sign}${n.startLine} to ${sign}${n.line}` : `line ${sign}${n.line}`;
  }
  // The code a note was on, above it in its file's list: the lines it was written on when they're
  // gone, else its lines (outside the diff).
  function noteSnippet(n) {
    const w = n.gone ? n.wrote : n;
    const from = w.startLine != null ? w.startLine : w.line;
    if (!w.code || !w.code.length) return '';
    return `<div class="th-hunk${n.gone ? ' gone' : ''}">${w.code.map((t, i) => `<div class="${n.gone ? 'd' : ''}"><span class="no">${from + i}</span>${esc(t) || ' '}</div>`).join('')}</div>`;
  }
  // Whether an agent has read a note: held, read, or waiting for its next untangle watch.
  function noteStatus(n) {
    const st = n.status;
    if (st === 'held') return '<span class="cm-tag held" title="Live review is off: it waits until you send it, from the Notes menu">Held</span>';
    if (st && st.read) return `<span class="cm-st" title="${esc(st.read)} read it through untangle watch">read by ${esc(st.read)}</span>`;
    if (st === 'queued') {
      const q = agentsNow().find((a) => a.state === 'queued' && a.on.includes(n.n));
      return q ? `<span class="cm-st" title="A line from untangle in ${esc(q.name)}’s chat says it’s here">queued for ${esc(q.name)}</span>` : '<span class="cm-st" title="An agent’s next untangle watch reads it">not read yet</span>';
    }
    if (st === 'nobody') return '<span class="cm-st warn" title="No untangle watch is waiting in the chat of an agent holding the review: the label in the bar says more">no one is listening</span>';
    return '';
  }
  const AGENT_AV = '<span class="av ag" aria-hidden="true">✦</span>';
  // A comment of a note: yours, or an agent's (its mark, its name). The note's first comment leads
  // with its number, its lines and its tags.
  function noteCommentHtml(n, c, first, lead) {
    const mine = c.by == null;
    const id = n.n + ':' + c.id, key = 'nedit:' + id;
    // Your comments can be edited and deleted; an agent's note, deleted (its answers stay its own).
    // What an agent wrote copies as it wrote it, to post or keep elsewhere.
    const trash = iconBtn(ICON.trash, lead ? 'Delete the note' : 'Delete', `data-act="nt-delete" data-n="${n.n}" data-id="${esc(c.id)}"${ntBusyAttr('del:' + id)}`);
    const copy = iconBtn(ICON.copy, lead ? 'Copy the note’s text' : 'Copy its text', `data-act="nt-copy-text" data-n="${n.n}" data-id="${esc(c.id)}"`);
    const tools = mine ? iconBtn(ICON.edit, 'Edit', `data-act="nt-edit-open" data-n="${n.n}" data-id="${esc(c.id)}"`) + trash : copy + (lead ? trash : '');
    const body = NT.editing === id
      ? composerHtml(key, { local: true, buttons: [[lead ? 'Update note' : 'Update reply', `data-act="nt-edit" data-n="${n.n}" data-id="${esc(c.id)}"`, true]], cancel: 'nt-edit-cancel' })
      : `<div class="cm-body">${noteMd(c.body)}</div>`;
    const when = `<span title="${esc(new Date(c.at).toLocaleString())}">${ago(c.at)}${c.edited ? ' · edited' : ''}</span>`;
    const since = (what) => `<span class="cm-tag since" title="${what === 'Gone' ? 'The commits since you wrote it removed its lines' : 'The commits since you wrote it changed its lines: it’s on the lines that replaced them'}">${what} since <code>${esc(shortSha(n.wrote.head))}</code></span>`;
    const agentTag = mine ? '' : '<span class="cm-tag">Agent</span>';
    const tags = lead ? '<span class="cm-tag local" title="Kept on this machine, not on GitHub">Local</span>' + agentTag + (n.gone ? since('Gone') : n.changed ? since('Changed') : '') + noteStatus(n) : agentTag;
    const av = lead ? `<span class="nt-n" title="Note ${n.n}: “N${n.n}” names it to your agent">N${n.n}</span>` : mine ? '<span class="av"></span>' : AGENT_AV;
    const head = first ? `<div class="cm-h"><b class="cm-who">${mine ? 'You' : esc(c.by)}</b>${lead ? `<span>${esc(noteLines(n))}</span>` : ''}${tags}${when}</div>` : '';
    const err = NT.errors.get('del:' + id);
    return `<div class="cm${first ? ' first' : ''}${mine ? '' : ' agent'}" data-comment="${esc(c.id)}">${first ? av : '<span></span>'}<div class="cm-main">${head}${body}${err ? `<div class="cmp-err" role="alert">${esc(err)}</div>` : ''}</div>${first ? '' : `<span class="cm-t">${when}</span>`}${tools ? `<span class="cm-tools">${tools}</span>${cmMoreHtml('nt:' + id)}` : ''}</div>`;
  }
  // A note under its lines: a thread with orchid on its edge. Resolved notes fold, saying who
  // resolved them: you, or the agent.
  function noteHtml(n, o) {
    o = o || {};
    const open = !n.resolved || NT.opened.has(n.n);
    const k = n.comments.length;
    let h = `<div class="th note${n.resolved ? ' resolved' : ''}${n.resolved && n.resolved.by ? ' by-agent' : ''}" data-note="${n.n}">`;
    if (n.resolved || o.head) {
      const by = !n.resolved ? '' : n.resolved.by ? `<span class="ag-mark" aria-hidden="true">✦</span><span>Resolved by ${esc(n.resolved.by)}</span>` : `${ICON.check}<span>Resolved</span>`;
      h += `<button type="button" class="th-fold" data-act="nt-fold" data-n="${n.n}" aria-expanded="${open}"><span class="tw">${open ? ICON.chevronDown : ICON.chevronRight}</span>${by}${o.head ? `<span>${o.head}</span>` : ''}<span class="muted">· N${n.n} · ${esc(noteLines(n))} · ${k} comment${k === 1 ? '' : 's'}</span></button>`;
    }
    if (!open) return h + '</div>';
    if (n.quote) h += `<div class="nt-quote"><span class="muted">On ${esc(n.quote.author || 'a')}’s thread on GitHub</span><div class="cm-body">${noteMd(n.quote.body.split('\n').map((l) => '> ' + l).join('\n'))}</div></div>`;
    let prev = null;
    h += n.comments.map((c, i) => { const first = !prev || prev.by !== c.by || i === 1; prev = c; return noteCommentHtml(n, c, first, i === 0); }).join('');
    if (n.changed && !n.gone && NT.was.has(n.n)) {
      const w = n.wrote, from = w.startLine != null ? w.startLine : w.line;
      h += `<div class="nt-was"><p>The lines it was written on, at <code>${esc(shortSha(w.head))}</code>:</p>${w.code.map((t, i) => `<div class="r"><span class="no">${from + i}</span><span class="tx">${esc(t) || ' '}</span></div>`).join('')}</div>`;
    }
    const key = 'nreply:' + n.n, err = NT.errors.get('res:' + n.n) || NT.errors.get('post:' + n.n);
    const reply = NT.replying.has(n.n) || drafts.has(key)
      ? composerHtml(key, { local: true, dest: true, placeholder: 'Reply…', rows: 3, buttons: [['Reply', `data-act="nt-reply" data-n="${n.n}"`, true]], cancel: 'nt-reply-cancel' })
      : `<button type="button" class="th-reply" data-act="nt-reply-open" data-n="${n.n}">Reply…</button>`;
    const btn = (act, label, title, extra) => `<button type="button" class="btn sm" data-act="${act}" data-n="${n.n}" title="${esc(title)}"${extra || ''}>${label}</button>`;
    const tools = (n.changed && !n.gone ? btn('nt-was', NT.was.has(n.n) ? 'Hide the lines it was on' : 'Show the lines it was on', `The lines you wrote it on, at ${shortSha(n.wrote.head)}`, ` aria-expanded="${NT.was.has(n.n)}"`) : '')
      + btn('nt-copy1', 'Copy', 'Copy this note for your agent')
      + (!n.resolved && !n.gone && canPost() ? btn('nt-post1', NT.busy === 'post:' + n.n ? 'Posting…' : 'Post to GitHub', 'Post it into your pending review on GitHub: it leaves the notes', ntBusyAttr('post:' + n.n)) : '')
      + btn('nt-resolve', n.resolved ? 'Unresolve' : 'Resolve', n.resolved ? 'Open it again' : 'Resolve it: it folds away', ntBusyAttr('res:' + n.n));
    h += `<div class="th-f">${reply}<span class="th-tools">${tools}</span>${err ? `<div class="cmp-err" role="alert">${esc(err)}</div>` : ''}</div>`;
    return h + '</div>';
  }
  // The threads and notes on a section's lines (each kind, for its color), and how many of them all
  // are open.
  function threadsIn(f, hi, s0, e0) {
    const out = { threads: 0, notes: 0, open: 0 };
    if (!GH.anchors.size && !NT.anchors.size) return out;
    const meta = hunkMeta(f.hunks[hi]);
    const add = (kind, list) => (list || []).forEach((t) => { out[kind]++; if (!t.resolved) out.open++; });
    for (let i = s0; i < e0; i++) {
      const r = meta[i];
      if (r.n != null && r.t !== '-') { add('threads', GH.anchors.get(f.p + '\nRIGHT\n' + r.n)); add('notes', NT.anchors.get(f.p + '\nRIGHT\n' + r.n)); }
      if (r.o != null && r.t !== '+') { add('threads', GH.anchors.get(f.p + '\nLEFT\n' + r.o)); add('notes', NT.anchors.get(f.p + '\nLEFT\n' + r.o)); }
    }
    return out;
  }
  const openThreadsHtml = (p) => {
    const e = GH.on && GH.files.get(p), n = NT.files.get(p);
    return (e && e.open ? `<span class="cm-cnt" title="Open threads">${ICON.comment}${e.open}</span>` : '') + (n && n.open ? `<span class="cm-cnt note" title="Open notes">${ICON.comment}${n.open}</span>` : '');
  };
  // A line of a file's diff by side: its hunk and row.
  function rowAt(path, side, line) {
    const x = side === 'LEFT' ? M().old.get(path + ':' + line) : M().head.get(path + ':' + line);
    return x ? { hi: x.hi, ri: x.ri, side, line } : null;
  }
  // Opens the composer on the lines from `from` to `to` (one line when they're the same), within a hunk.
  function composeRange(from, to) {
    const a = rowAt(from.path, from.side, from.line), b = rowAt(to.path, to.side, to.line);
    if (a && b && a.hi !== b.hi) return toast('A comment’s lines must be in one hunk.');
    const one = !a || !b || a.ri === b.ri;
    const [s, e] = one ? [a, a] : a.ri < b.ri ? [a, b] : [b, a];
    // The text written so far stays with the composer while its lines change.
    const c = state.compose;
    const key = c && c.path === from.path && c.anchor.side === from.side && c.anchor.line === from.line ? c.key : `new:${from.path}:${from.side}:${from.line}`;
    state.compose = {
      key, anchor: { side: from.side, line: from.line }, path: from.path,
      side: one ? from.side : e.side, line: one ? from.line : e.line,
      startSide: one ? null : s.side, startLine: one ? null : s.line,
      hi: a ? a.hi : null, r0: s ? s.ri : -1, r1: e ? e.ri : -1,
    };
    GH.focus = key;
    render();
  }
  // Opens the composer on a line; with shift, stretches the open one to it.
  function openCompose(at, extend) {
    const c = state.compose;
    if (extend && c && c.path === at.path && c.hi != null) return composeRange({ path: c.path, side: c.anchor.side, line: c.anchor.line }, at);
    return composeRange(at, at);
  }
  // The lines a suggestion starts from: the new side's lines in the comment's range.
  function suggestionLines(c) {
    const f = M().files.find((x) => x.p === c.path);
    if (!f || c.hi == null) return [];
    const h = f.hunks[c.hi];
    const out = [];
    for (let i = c.r0; i <= c.r1; i++) if (h.meta[i].t !== '-') out.push(h.rows[i][1]);
    return out;
  }
  function openThread(id) {
    const t = GH.data && GH.data.threads.find((x) => x.id === id);
    if (!t) return;
    if (t.resolved) GH.opened.add(t.id);
    state.peek = null;
    const inModel = M().files.some((f) => f.p === t.path) || M().generated.some((f) => f.p === t.path);
    state.view = inModel ? { kind: 'file', path: t.path } : { kind: 'conversation' };
    if (t.at != null) {
      const r = rowAt(t.path, t.side, t.at);
      if (r) { const k = 'file|' + t.path + '#' + r.hi + ':0'; state.collapsed.delete(k); state.expanded.add(k); }
    } else if (!t.file) GH.away.add(t.path);
    GH.reveal = t.id;
    render({ top: true });
  }
  // The pull request's conversation: its description, comments and reviews, and a new comment.
  function renderConversation() {
    if (!GH.on) return `<div class="empty">${esc((CONFIG.github && CONFIG.github.off) || 'This review has no pull request.')}</div>`;
    const d = GH.data;
    if (!d) return `<div class="empty">${GH.error ? esc(GH.error) : 'Loading the conversation from GitHub…'}</div>`;
    const pr = d.pr;
    const state1 = pr.draft ? 'Draft' : { OPEN: 'Open', MERGED: 'Merged', CLOSED: 'Closed' }[pr.state] || pr.state;
    const decision = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' }[pr.decision] || '';
    const open = d.threads.filter((t) => !t.resolved).length;
    let h = headerHtml({
      crumbs: `<button type="button" data-tab="comments" title="Show the threads">Conversation</button>${SEP}<b class="ui" title="${esc(pr.title)}">${esc(pr.title)}</b>`,
      facts: `<span class="pr-state ${esc(pr.state.toLowerCase())}${pr.draft ? ' draft' : ''}">${state1}</span>${decision ? ` · ${decision}` : ''} · ${esc(pr.author.login)} opened it ${ago(pr.created)} · ${open} open thread${open === 1 ? '' : 's'}`,
      action: `<a class="btn" href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer">Open on GitHub</a>`,
    });
    h += '<div class="conv">' + commentHtml({ id: pr.id, author: pr.author, association: '', html: pr.html, created: pr.created, edited: null, url: pr.url, pending: false, canEdit: false, canDelete: false, canReact: pr.canReact, reactions: pr.reactions }, 'pr', true);
    const items = d.comments.map((c) => ({ at: c.created, c })).concat(d.reviews.map((r) => ({ at: r.created, r }))).sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
    const VERB = { APPROVED: ['approved these changes', 'ok'], CHANGES_REQUESTED: ['requested changes', 'no'], COMMENTED: ['reviewed', ''], DISMISSED: ['reviewed (dismissed)', ''] };
    items.forEach(({ c, r }) => {
      if (c) { h += commentHtml(c, 'issue', true); return; }
      const [verb, cls] = VERB[r.state] || ['reviewed', ''];
      h += `<div class="tl-ev ${cls}">${avatar(r.author, 40)}<span><a class="cm-who" href="${esc(r.author.url)}" target="_blank" rel="noopener noreferrer">${esc(r.author.login)}</a> ${verb}${r.comments ? ` · ${r.comments} comment${r.comments > 1 ? 's' : ''}` : ''} <span class="muted">${ago(r.created)}</span></span></div>`;
      if (r.body) h += `<div class="tl-body cm-body">${clean(r.html)}</div>`;
    });
    h += `<div class="conv-new">${composerHtml('issue', { placeholder: 'Add a comment to the conversation', buttons: [['Comment', 'data-act="gh-comment"', true]] })}</div></div>`;
    return h;
  }
  // The notes in the Threads tab: open ones in the files' order, then the resolved ones.
  function notesTabHtml() {
    const d = NT.data;
    if (!d) return `<div class="sb-gh">${NT.error ? `<span class="d">${esc(NT.error)}</span>` : 'Loading the notes…'}</div>`;
    const order = new Map(M().files.map((f, i) => [f.p, i]));
    const sorted = d.notes.slice().sort((x, y) => (order.has(x.path) ? order.get(x.path) : 1e9) - (order.has(y.path) ? order.get(y.path) : 1e9) || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0) || (x.line || 0) - (y.line || 0));
    const row = (n) => {
      const last = n.comments[n.comments.length - 1];
      const text = last.body.replace(/```[\s\S]*?```/g, '[code]').replace(/[#>*_`]/g, '').replace(/\s+/g, ' ').trim();
      const where = n.file ? 'file' : n.startLine != null ? `${n.startLine}–${n.line}` : n.line;
      const mk = n.resolved ? (n.resolved.by ? '<i class="mk ok ag" aria-hidden="true">✦</i>' : `<i class="mk ok">${ICON.check}</i>`) : `<i class="mk note${n.changed || n.gone ? ' ch' : ''}"></i>`;
      const who = last.by ? `${last.by}: ` : n.comments.length > 1 ? 'You: ' : '';
      const resolved = n.resolved ? ` · resolved${n.resolved.by ? ` by ${n.resolved.by}` : ''}` : '';
      return `<button type="button" class="sb-row thr${n.resolved ? ' done' : ''}" data-act="nt-open" data-n="${n.n}" title="${esc(`N${n.n} · ${n.path}:${where}${resolved}${n.changed && !n.gone ? ' · changed since you wrote it' : n.gone ? ' · its lines are gone' : ''} · ${who}${trunc(text, 200)}`)}">${mk}<span class="nm">N${n.n} · ${esc(fileName(n.path))}:${where}<span class="sn">${esc(trunc(who + text, 90))}</span></span><span class="cnt">${n.comments.length > 1 ? n.comments.length : ''}</span></button>`;
    };
    const open = sorted.filter((n) => !n.resolved), done = sorted.filter((n) => n.resolved);
    let h = open.length ? open.map(row).join('') : `<div class="sb-gh">${localMode() ? 'None open: the + on a line writes one.' : 'None open.'}</div>`;
    if (done.length) {
      h += `<button type="button" class="sb-group" data-act="nt-resolved-toggle" aria-expanded="${NT.showResolved}"><span>Resolved notes</span><span>${done.length} ${NT.showResolved ? '▾' : '▸'}</span></button>`;
      if (NT.showResolved) h += done.map(row).join('');
    }
    return h;
  }
  // A section of the Threads tab, open or folded (kept in this browser): Notes, or From GitHub.
  const sectionOpen = (key) => !(Array.isArray(UI.foldedThreads) && UI.foldedThreads.includes(key));
  function threadsSectionHtml(key, label, title, count, body) {
    const open = sectionOpen(key);
    return `<button type="button" class="sb-sec ${key}" data-act="threads-fold" data-key="${key}" aria-expanded="${open}" title="${esc(title)}"><span class="tw">${open ? ICON.chevronDown : ICON.chevronRight}</span><i class="sw" aria-hidden="true"></i><span class="nm">${label}</span><span class="cnt">${count}</span></button>`
      + (open ? `<div class="sb-sec-body">${body}</div>` : '');
  }
  // The Threads tab: the notes (in local mode, or when there are some) and what comes from GitHub,
  // each a section that folds; then the conversation, and threads, open ones first, in the files' order.
  function commentsTabHtml(v) {
    const gh = GH.on ? githubTabHtml(v) : `<div class="sb-gh">${esc((CONFIG.github && CONFIG.github.off) || 'This review has no pull request: comments stay here, as notes.')}</div>`;
    if (!NT.on || !(localMode() || (NT.data && NT.data.notes.length))) return gh;
    const notes = NT.data ? NT.data.notes.filter((n) => !n.resolved).length : '';
    const threads = GH.data ? GH.data.threads.filter((t) => !t.resolved).length : '';
    return threadsSectionHtml('notes', 'Notes', 'Kept on this machine, for your agent', notes, notesTabHtml())
      + threadsSectionHtml('github', GH.on ? 'From GitHub' : 'GitHub', GH.on ? 'The pull request’s conversation and threads' : 'This review has no pull request', threads, gh);
  }
  function githubTabHtml(v) {
    const d = GH.data;
    let h = `<div class="sb-gh">${GH.error ? `<span class="d">${esc(GH.error)}</span>` : !d ? 'Loading the conversation from GitHub…' : GH.loading ? 'Refreshing…' : `From GitHub, ${ago(new Date(GH.at).toISOString())}`}<span class="sp"></span>${iconBtn(ICON.refresh, 'Refresh from GitHub', 'data-act="gh-refresh"')}</div>`;
    if (!d) return h;
    if (GH.stale) h += `<div class="sb-warn">GitHub has newer commits (<code>${esc(d.pr.head.slice(0, 7))}</code>). Comments on lines wait for this review to be on them. <button type="button" class="linkish" data-act="refresh">Refresh</button></div>`;
    if (d.pending) h += `<button type="button" class="sb-pend" data-act="review-toggle">${d.pending.comments} pending comment${d.pending.comments === 1 ? '' : 's'} · Finish your review</button>`;
    h += `<button type="button" class="sb-row" data-act="conversation"${v.kind === 'conversation' ? ' aria-current="true"' : ''} title="The description, ${d.comments.length} comment${d.comments.length === 1 ? '' : 's'} and ${d.reviews.length} review${d.reviews.length === 1 ? '' : 's'}"><span class="tw">${ICON.discussion}</span><span class="nm ui">Conversation</span><span class="cnt">${d.comments.length || ''}</span></button>`;
    const order = new Map(M().files.map((f, i) => [f.p, i]));
    const sorted = d.threads.slice().sort((x, y) => (order.has(x.path) ? order.get(x.path) : 1e9) - (order.has(y.path) ? order.get(y.path) : 1e9) || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0) || (x.at || x.originalLine || 0) - (y.at || y.originalLine || 0));
    const row = (t) => {
      const c = t.comments[0];
      const text = c ? c.body.replace(/```[\s\S]*?```/g, '[code]').replace(/[#>*_`]/g, '').replace(/\s+/g, ' ').trim() : '';
      const where = t.file ? 'file' : t.at != null ? t.at : t.originalLine;
      const pend = t.comments.some((x) => x.pending);
      const mk = pend ? '<i class="mk pend"></i>' : t.resolved ? `<i class="mk ok">${ICON.check}</i>` : t.at == null && !t.file ? '<i class="mk away"></i>' : '<i class="mk gh"></i>';
      return `<button type="button" class="sb-row thr${t.resolved ? ' done' : ''}" data-act="thread-open" data-thread="${esc(t.id)}" title="${esc(t.path)}:${where}${c ? ` · ${esc(c.author.login)}: ${esc(trunc(text, 200))}` : ''}">${mk}<span class="nm">${esc(fileName(t.path))}:${where}<span class="sn">${esc(trunc(text, 90))}</span></span><span class="cnt">${t.comments.length > 1 ? t.comments.length : ''}</span></button>`;
    };
    const open = sorted.filter((t) => !t.resolved), done = sorted.filter((t) => t.resolved);
    h += `<div class="sb-group"><span>Open threads</span><span>${open.length}</span></div>` + (open.length ? open.map(row).join('') : '<div class="sb-gh">None open.</div>');
    if (done.length) {
      h += `<button type="button" class="sb-group" data-act="resolved-toggle" aria-expanded="${GH.showResolved}"><span>Resolved</span><span>${done.length} ${GH.showResolved ? '▾' : '▸'}</span></button>`;
      if (GH.showResolved) h += done.map(row).join('');
    }
    return h;
  }
  // The top bar's review button and, opened, its menu: where new comments go, then the review to
  // finish (a summary and a verdict) or, in local mode, the notes to copy for the agent.
  function renderReviewBar() {
    renderAgent();
    const el = $('#vw-review');
    if (!el) return;
    el.hidden = !GH.on && !NT.on;
    if (el.hidden) return;
    const local = localMode();
    const d = GH.data, n = d && d.pending ? d.pending.comments : 0;
    const open = NT.data ? NT.data.notes.filter((x) => !x.resolved).length : 0;
    const label = local ? `Notes${open ? ` <span class="rv-n nt">${open}</span>` : ''}` : n ? `Finish review <span class="rv-n">${n}</span>` : 'Review';
    const more = $('#vw-more');
    if (more) more.classList.toggle('has', local ? !!open : !!n);
    const title = local ? 'Your notes, kept on this machine: copy them for your agent, or post them to GitHub' : n ? `Finish your review: ${n} pending comment${n === 1 ? '' : 's'}` : 'Comment on, approve or request changes to the pull request';
    let h = '';
    if (GH.reviewOpen) {
      h += modeHtml();
      if (local) h += notesPopHtml();
      else if (!d) h += `<p class="rv-sub">${GH.error ? esc(GH.error) : 'Loading the conversation from GitHub…'}</p>`;
      else {
        const mine = d.pr.mine;
        const opt = (ev, label, note, off) => `<label class="rv-opt${off ? ' off' : ''}"><input type="radio" name="rv-event" value="${ev}"${GH.event === ev ? ' checked' : ''}${off ? ' disabled' : ''}><span><b>${label}</b><span class="muted">${note}</span></span></label>`;
        const kept = NT.data ? NT.data.notes.length : 0;
        h += `<div class="rv-h"><b>Finish your review</b><span class="muted">${n ? `${n} pending comment${n === 1 ? '' : 's'}` : 'no pending comments'}</span></div>`
          + (GH.stale ? `<div class="sb-warn">GitHub has newer commits than this review (<code>${esc(d.pr.head.slice(0, 7))}</code>). <button type="button" class="linkish" data-act="refresh">Refresh</button></div>` : '')
          + composerHtml('review', {
            placeholder: 'Leave a comment', rows: 4,
            extra: `<div class="rv-opts">${opt('COMMENT', 'Comment', 'General feedback, without approving.', false)}${opt('APPROVE', 'Approve', mine ? 'Not for your own pull request.' : 'Feedback, and approval to merge.', mine)}${opt('REQUEST_CHANGES', 'Request changes', mine ? 'Not for your own pull request.' : 'Feedback that must be addressed before merging.', mine)}</div>`,
            buttons: (n ? [['Discard pending review', 'data-act="gh-discard"', false]] : []).concat([['Submit review', 'data-act="gh-submit"', true]]),
          })
          + (kept ? `<p class="rv-sub">Your ${kept} local note${kept === 1 ? '' : 's'} stay${kept === 1 ? 's' : ''} here. Switch to Local notes to copy them.</p>` : '');
      }
    }
    // What had the focus in the menu keeps it as the menu is drawn again: a radio, the switch, the
    // line for the agent (with its caret). Drafts get theirs back from render.
    const ae = el.contains(document.activeElement) ? document.activeElement : null;
    const sel = !ae ? null : ae.name ? `[name="${ae.name}"]${ae.type === 'radio' ? `[value="${ae.value}"]` : ''}` : ae.matches('[data-nt-opening]') ? '[data-nt-opening]' : ae.dataset.act && ae.dataset.draft == null ? `[data-act="${ae.dataset.act}"]${ae.dataset.mode ? `[data-mode="${ae.dataset.mode}"]` : ''}` : null;
    const caret = ae && ae.matches('[data-nt-opening]') ? [ae.selectionStart, ae.selectionEnd, ae.scrollTop] : null;
    // The button, and its menu while it's open: one element as it opens and is drawn again, and
    // as it closes into the button, out of reach, before it goes.
    let btn = el.querySelector(':scope > .rv-btn'), box = el.querySelector(':scope > .rv-pop');
    if (!btn) { el.insertAdjacentHTML('afterbegin', '<button type="button" class="btn rv-btn" data-act="review-toggle" aria-haspopup="dialog"></button>'); btn = el.firstElementChild; }
    btn.className = `btn rv-btn${local ? ' local' : ''}`;
    btn.setAttribute('aria-expanded', String(GH.reviewOpen));
    btn.title = title;
    btn.innerHTML = label + ICON.chevronDown;
    if (GH.reviewOpen) {
      const opening = !box || box.inert;
      if (!box) { box = document.createElement('div'); box.setAttribute('role', 'dialog'); el.appendChild(box); sheetTouch(box); }
      box.className = `rv-pop${local ? ' local' : ''}`;
      box.setAttribute('aria-label', local ? 'Your notes' : 'Finish your review');
      box.inert = false;
      box.innerHTML = (compact() ? SHEET_HANDLE : '') + h;
      fitBoxes(box);
      if (opening) {
        const b = btn.getBoundingClientRect(), r = box.getBoundingClientRect();
        box.style.transformOrigin = compact() ? '50% 100%' : `${Math.round(b.left + b.width / 2 - r.left)}px 0`;
        pop(box, true);
      }
    } else if (box && !box.inert) {
      const gone = box;
      gone.inert = true;
      pop(gone, false, () => gone.remove());
    }
    const again = sel && el.querySelector(sel);
    if (again) {
      again.focus({ preventScroll: true });
      if (caret) { again.setSelectionRange(caret[0], caret[1]); again.scrollTop = caret[2]; }
    }
    layerSoon();
  }
  // The menu's switch: new comments go to GitHub, or stay here as notes.
  function modeHtml() {
    const local = localMode(), can = ghCan();
    const why = !GH.on ? ((CONFIG.github && CONFIG.github.off) || 'This review has no pull request') : `GitHub didn’t answer: ${GH.error || ''}`;
    return `<div class="rv-mode"><b>Comments go to</b><div class="mini-seg rv-seg" role="group" aria-label="Comments go to">`
      + `<button type="button" data-act="nt-mode" data-mode="github" aria-pressed="${!local}"${can ? '' : ` disabled title="${esc(why)}"`}><i class="sw gh"></i>GitHub</button>`
      + `<button type="button" data-act="nt-mode" data-mode="local" aria-pressed="${local}" title="Keep new comments on this machine, as notes for your agent"><i class="sw"></i>Local notes</button></div></div>`;
  }
  // The Notes menu: what's kept, live review, the line the copy opens with, which notes it takes,
  // and the two ways out: Copy for agent, Post to GitHub.
  function notesPopHtml() {
    const d = NT.data;
    if (!d) return `<p class="rv-sub">${NT.error ? esc(NT.error) : 'Loading the notes…'}</p>`;
    const open = d.notes.filter((x) => !x.resolved), fresh = open.filter((x) => !x.copied);
    const a = agentFirst();
    const pr = /^#(\d+)\s/.exec(M().raw.title || '');
    const opt = (v, label, k) => `<label class="rv-opt"><input type="radio" name="nt-scope" value="${v}"${d.scope === v ? ' checked' : ''}><span><b>${label}</b></span><span class="ct">${k}</span></label>`;
    let h = `<p class="rv-sub"><b>${open.length} open note${open.length === 1 ? '' : 's'}</b>, kept for ${pr ? '#' + pr[1] : 'this review'} on this machine. Nothing leaves it until you copy or post ${open.length === 1 ? 'it' : 'them'}, or an agent runs <code>untangle watch</code>.</p>`;
    if (a) h += `<p class="rv-sub rv-agent st-${a.state}"><i class="dot"></i><span><b>${esc(agentLabel(a))}</b>${a.state === 'deaf' || a.state === 'left' ? ': what you write waits for the next untangle watch.' : d.live ? ': notes and replies reach it as you write them.' : ': notes and replies wait until you send them.'}</span></p>`;
    h += `<label class="rv-check"><input type="checkbox" name="nt-live"${d.live ? ' checked' : ''}><span><b>Live review</b><span class="muted">${d.live ? 'Notes and replies reach a watching agent as you write them.' : 'Notes and replies wait until you send them, like a pending review.'}</span></span></label>`;
    if (d.held) h += `<button type="button" class="sb-pend nt" data-act="nt-send"${ntBusyAttr('send')}>Send ${d.held} held comment${d.held === 1 ? '' : 's'}${a ? ` to ${esc(a.name)}` : ''}</button>`;
    h += `<label class="rv-lbl" for="nt-opening">For the agent</label><textarea id="nt-opening" class="rv-ta" data-nt-opening rows="2" placeholder="The line the copy opens with">${esc(NT.opening != null ? NT.opening : d.opening)}</textarea>`;
    h += `<div class="rv-opts" role="radiogroup" aria-label="Which notes to copy">${opt('open', 'Open notes', open.length)}${opt('new', 'Not copied yet', fresh.length)}${opt('all', 'All including resolved', d.notes.length)}</div>`;
    const pend = GH.data && GH.data.pending ? GH.data.pending.comments : 0;
    if (pend) h += `<button type="button" class="sb-pend" data-act="nt-mode" data-mode="github">${pend} pending on GitHub · Finish your review</button>`;
    const err = NT.errors.get('post') || NT.errors.get('send');
    if (err) h += `<div class="cmp-err" role="alert">${esc(err)}</div>`;
    // Your open notes post as your review; an agent's, one at a time, from the note.
    const postable = open.filter((x) => !x.gone && x.comments[0].by == null).length;
    h += `<div class="rv-f">${GH.on ? `<button type="button" class="btn sm" data-act="nt-post" title="${canPost() ? 'Your open notes become threads of your pending review on GitHub, and leave the notes' : 'GitHub can’t take them now'}"${canPost() && postable ? '' : ' disabled'}${ntBusyAttr('post')}>${NT.busy === 'post' ? 'Posting…' : 'Post to GitHub'}</button>` : ''}`
      + `<button type="button" class="btn sm primary" data-act="nt-copy"${ntScoped(d.scope).length ? '' : ' disabled'}>Copy for agent</button></div>`;
    return h;
  }
  // An agent's menu: where its chat is and what reaches it, and Wake while nothing listens there.
  function agentPopHtml(a) {
    const watch = '<code>untangle watch</code>', name = esc(a.name);
    const nobody = NT.data.notes.filter((n) => !n.resolved && n.status === 'nobody').map((n) => n.n);
    const waits = nobody.length ? `${nList(nobody)} ${nobody.length === 1 ? 'reaches' : 'reach'} nobody yet` : 'what you write reaches nobody yet';
    const said = {
      listening: a.kind === 'codex' ? `Its chat is open. Three seconds after your last note or reply, untangle puts a line in it with <code>codex queue</code>, and ${name} reads them.`
        : `A watch from its chat is waiting: what you write reaches it three seconds after your last note or reply.`,
      working: `It has ${a.on.length ? nList(a.on) : 'what its last watch brought'}. What you write now ${a.kind === 'codex' ? 'reaches it in a line from untangle, after this turn' : `goes with its next ${watch}`}.`,
      queued: a.kind === 'codex' && a.busy ? `${name} is busy with something you asked in its chat. The line from untangle waits in its queue, and starts its next turn.`
        : `untangle ${a.kind === 'codex' ? 'put' : 'typed'} a line into its chat: its next turn reads what’s new.`,
      deaf: !a.kind ? `No ${watch} of its own is waiting, so ${waits}.`
        : a.busy ? `Its chat is busy, and no ${watch} is waiting there: what you write waits until it runs one.`
          : `Its chat is open, but no ${watch} is waiting there, so ${waits}.${a.orca ? '' : ' Ask in its chat to watch the review again, or copy the notes for it.'}`,
      left: `Its chat ended. The review stays open, and what you write waits for the next chat that runs ${watch}, which gets every open note.`,
    }[a.state];
    const who = [a.kind === 'claude' ? `Claude session ${a.chat.slice(0, 8)}` : a.kind === 'codex' ? `Codex thread ${a.chat.slice(0, 8)}` : 'untangle watch', a.orca ? 'Orca terminal' : '', a.state === 'left' ? 'ended' : a.busy === true ? 'busy' : a.busy === false ? 'idle' : ''].filter(Boolean).join(' · ');
    const err = NT.errors.get('wake:' + a.name) || a.error;
    let h = `<h4><i class="dot"></i>${esc(agentLabel(a))}</h4><p>${said}</p>`;
    if (a.wake) h += `<div class="ag-line"><small>Wake types into its chat, in Orca</small>${esc(a.wake)}</div>`;
    if (err) h += `<div class="cmp-err" role="alert">${esc(err)}</div>`;
    h += `<p class="ag-who">${esc(who)}</p>`;
    if (a.state === 'deaf' || a.state === 'left') {
      h += `<div class="rv-f"><button type="button" class="btn sm" data-act="nt-copy">Copy for agent</button>`
        + (a.wake ? `<button type="button" class="btn sm primary" data-act="nt-wake" data-agent="${name}"${ntBusyAttr('wake:' + a.name)}>${NT.busy === 'wake:' + a.name ? 'Waking…' : `Wake ${name}`}</button>` : '') + '</div>';
    }
    return h;
  }
  // The bar's labels, one per agent holding the review: where its chat is. Each opens its menu.
  function renderAgent() {
    const el = $('#vw-agent');
    if (!el) return;
    sheetTouch(el);
    const list = agentsNow();
    el.hidden = !list.length;
    if (NT.agentOpen && !list.some((a) => a.name === NT.agentOpen)) NT.agentOpen = null;
    const h = list.map((a) => {
      const open = NT.agentOpen === a.name, label = esc(agentLabel(a));
      return `<span class="vw-agent-w"><button type="button" class="vw-agent st-${a.state}" data-act="nt-agent" data-agent="${esc(a.name)}" aria-expanded="${open}" aria-haspopup="dialog"><i class="dot"></i><span class="ag-l" data-n="${esc(a.name)}">${label}</span>${ICON.chevronDown}</button>`
        + (open ? `<div class="ag-pop st-${a.state}" role="dialog" aria-label="${label}">${compact() ? SHEET_HANDLE : ''}${agentPopHtml(a)}</div>` : '') + '</span>';
    }).join('');
    layerSoon();
    if (el.innerHTML === h) return;
    // The button that had the focus keeps it as the labels are drawn again.
    const ae = el.contains(document.activeElement) ? document.activeElement : null;
    const sel = ae && ae.dataset.act ? `[data-act="${ae.dataset.act}"]${ae.dataset.agent ? `[data-agent="${CSS.escape(ae.dataset.agent)}"]` : ''}` : null;
    el.innerHTML = h;
    const again = sel && el.querySelector(sel);
    if (again) again.focus({ preventScroll: true });
  }
  let toastTimer = null;
  // ---------- Reviews: the others on this machine, from this one. untangle reads them as its
  // manager lists them; a click brings one's tab to the front.
  const RV = { list: null, self: null, said: new Set(), timer: 0 };
  const revsEl = $('#vw-revs');
  const rvName = (r) => r.name.replace(/^[^#]*#/, '#');
  function revsPopHtml() {
    const list = RV.list || [];
    const items = list.map((r) => `<button type="button" class="rv-it" data-act="rv-open" data-id="${esc(r.id)}"${r.status === 'running' ? '' : ' title="Paused: it starts again from the manager"'}><i class="dot${r.status === 'paused' ? ' paused' : r.need ? ' need' : ''}"></i><span class="num">${esc(rvName(r))}</span><span class="t">${esc(r.title)}</span><small class="${r.need ? 'need' : ''}">${esc(r.need || (r.twin ? 'open twice' : r.status === 'paused' ? 'paused' : r.agents[0] ? r.agents[0].label : r.build ? 'building' : r.older ? 'older untangle' : ''))}</small></button>`).join('');
    return `<div class="rv-h">Your reviews<button type="button" class="linkish" data-act="rv-manager">Open the manager</button></div>${RV.list ? items || '<p class="rv-none">No other reviews: this one is the only one.</p>' : '<p class="rv-none">Asking untangle…</p>'}<button type="button" class="rv-new" data-act="rv-new"><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>Start a review</button>`;
  }
  function rvLoad() {
    clearTimeout(RV.timer);
    if (document.visibilityState === 'hidden') return;
    api('reviews').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d) return;
      const first = !RV.list;
      RV.self = d.self;
      RV.list = d.reviews.filter((r) => r.id !== d.self && r.status !== 'closed');
      // A review that needs you, newly: said once, unless it's what the page found as it opened.
      RV.list.forEach((r) => { if (r.need && !RV.said.has(r.id + r.need)) { RV.said.add(r.id + r.need); if (!first) toast(`${r.need} on ${rvName(r)}`); } });
      const need = RV.list.filter((r) => r.status === 'running' && r.need).length;
      const n = $('#vw-revs-n');
      n.hidden = !need;
      n.textContent = need;
      revsEl.title = need ? `Your other reviews: ${need} need${need === 1 ? 's' : ''} you` : 'Your other reviews';
      if (MENU.open === 'reviews') renderMenu();
    }).catch(() => {}).finally(() => { RV.timer = setTimeout(rvLoad, MENU.open === 'reviews' ? 3000 : 15000); });
  }

  function toast(msg) {
    let el = $('#vw-toast');
    if (!el) { el = document.createElement('div'); el.id = 'vw-toast'; el.className = 'toast'; el.setAttribute('role', 'status'); viewer.appendChild(el); }
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 3500);
  }
  // The + that starts a comment, over the line under the pointer (one button, moved around).
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'cm-add';
  addBtn.textContent = '+';
  addBtn.title = 'Comment on this line (shift-click: on the lines from the open comment to this one)';
  addBtn.setAttribute('aria-label', 'Comment on this line');
  let addAt = null;
  function placeAdd(cell) {
    const code = cell.closest('.code[data-p]');
    if (!code || !canCommentLines()) { addBtn.classList.remove('on'); return; }
    const [side, line] = cell.dataset.c.split(':');
    addAt = { path: code.dataset.p, side: side === 'L' ? 'LEFT' : 'RIGHT', line: Number(line), cell };
    const mr = main.getBoundingClientRect(), r = cell.getBoundingClientRect();
    const sg = cell.querySelector('.sg') || cell;
    const sr = sg.getBoundingClientRect();
    addBtn.style.top = `${r.top - mr.top + main.scrollTop + Math.max(0, (Math.min(r.height, 21) - 20) / 2)}px`;
    addBtn.style.left = `${sr.left - mr.left + main.scrollLeft - 12}px`;
    addBtn.classList.add('on');
  }
  main.addEventListener('mouseover', (e) => {
    if ((!GH.on && !NT.on) || drag || e.target === addBtn) return;
    const cell = e.target.closest('[data-c]');
    if (cell && main.contains(cell)) placeAdd(cell); else addBtn.classList.remove('on');
  });
  main.addEventListener('mouseleave', () => { if (!drag) addBtn.classList.remove('on'); });
  // Pointing at an open thread or note, or at its bar in the gutter, tints the lines it's on; a
  // click on the bar goes to it.
  let lit = '';
  function lightComments(ids) {
    const key = ids.join(' ');
    if (key === lit) return;
    lit = key;
    main.querySelectorAll('.cm-hot, .nt-hot').forEach((x) => x.classList.remove('cm-hot', 'nt-hot'));
    ids.forEach((id) => {
      const mk = marks().byId.get(id);
      if (!mk) return;
      main.querySelectorAll('.code[data-p]').forEach((code) => {
        if (code.dataset.p !== mk.path) return;
        mk.keys.forEach((k) => code.querySelectorAll(`[data-c="${k}"]`).forEach((c) => c.closest('.ln, .sl')?.classList.add(mk.kind === 'gh' ? 'cm-hot' : 'nt-hot')));
      });
    });
  }
  // The open threads and notes a row is under.
  function commentsAt(row) {
    const code = row.closest('.code[data-p]'), p = code && marks().byPath.get(code.dataset.p);
    if (!p) return [];
    const keys = [row.dataset.c, ...[...row.querySelectorAll('[data-c]')].map((x) => x.dataset.c)].filter(Boolean);
    return [...new Set(keys.flatMap((k) => p.byKey.get(k) || []))];
  }
  const markedRow = (el) => (el.closest('.g') && !el.closest('button') ? el.closest('.ln.cm-on, .ln.nt-on, .sl.cm-on, .sl.nt-on') : null);
  // A thread's or a note's box, by the id marks give it ('gh:<thread>', 'nt:<n>'), and back.
  const thKey = (th) => (th.dataset.note != null ? 'nt:' + th.dataset.note : 'gh:' + th.dataset.thread);
  const thEl = (id) => (id.startsWith('nt:') ? main.querySelector(`.th.note[data-note="${id.slice(3)}"]`) : [...main.querySelectorAll('.th[data-thread]')].find((x) => x.dataset.thread === id.slice(3)));
  main.addEventListener('mouseover', (e) => {
    if (drag) return;
    const th = e.target.closest('.th[data-thread], .th.note[data-note]');
    if (th) return lightComments([thKey(th)]);
    const row = markedRow(e.target);
    lightComments(row ? commentsAt(row) : []);
  });
  main.addEventListener('mouseleave', () => lightComments([]));
  main.addEventListener('click', (e) => {
    const row = markedRow(e.target), id = row && commentsAt(row)[0];
    if (!id) return;
    const el = thEl(id);
    if (!el) return;
    placeRow(el, headH() + 40);
    el.classList.remove('flash-th');
    void el.offsetWidth;
    el.classList.add('flash-th');
  });
  // Pressing the + and dragging over lines comments on all of them, as on GitHub (within a hunk;
  // near the pane's edges it scrolls). Shift stretches the open comment instead.
  let drag = null, dragUp = 0;
  const cellAt = (x, y) => { const el = document.elementFromPoint(x, y); const c = el && el.closest('[data-c]'); return c && drag && drag.code.some((x) => x.contains(c)) ? c : null; };
  const atOf = (cell) => { const [side, line] = cell.dataset.c.split(':'); return { path: drag.at.path, side: side === 'L' ? 'LEFT' : 'RIGHT', line: Number(line) }; };
  function paintDrag() {
    main.querySelectorAll('.cm-drag').forEach((x) => x.classList.remove('cm-drag'));
    const cells = drag.code.flatMap((x) => [...x.querySelectorAll('[data-c]')]);
    let i = cells.indexOf(drag.cell), j = cells.indexOf(drag.end);
    if (i < 0 || j < 0) return;
    if (i > j) [i, j] = [j, i];
    for (let k = i; k <= j; k++) { const row = cells[k].closest('.ln, .sl'); if (row) row.classList.add('cm-drag'); }
  }
  function dragTo(x, y) {
    const cell = cellAt(x, y);
    if (!cell || cell === drag.end) return;
    const a = rowAt(drag.at.path, drag.at.side, drag.at.line), to = atOf(cell), b = rowAt(to.path, to.side, to.line);
    if (a && b && a.hi !== b.hi) return;
    drag.end = cell;
    drag.to = to;
    paintDrag();
  }
  function dragScroll() {
    if (!drag) return;
    const r = main.getBoundingClientRect(), top = r.top + headH();
    const dy = drag.y < top + 30 ? -12 : drag.y > r.bottom - 30 ? 12 : 0;
    if (dy) { main.scrollTop += dy; dragTo(drag.x, drag.y); }
    requestAnimationFrame(dragScroll);
  }
  addBtn.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !addAt || !addAt.cell) return;
    e.preventDefault();
    drag = { at: { path: addAt.path, side: addAt.side, line: addAt.line }, to: null, cell: addAt.cell, end: addAt.cell, code: codeRun(addAt.cell.closest('.code')), shift: e.shiftKey, x: e.clientX, y: e.clientY };
    document.body.classList.add('dragging');
    paintDrag();
    requestAnimationFrame(dragScroll);
  });
  document.addEventListener('mousemove', (e) => { if (!drag) return; drag.x = e.clientX; drag.y = e.clientY; dragTo(e.clientX, e.clientY); });
  document.addEventListener('mouseup', () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    dragUp = Date.now();
    document.body.classList.remove('dragging');
    main.querySelectorAll('.cm-drag').forEach((x) => x.classList.remove('cm-drag'));
    if (d.shift) openCompose(d.to || d.at, true);
    else composeRange(d.at, d.to || d.at);
  });
  // The keyboard's click (a mouse's already opened the composer on its way up).
  addBtn.addEventListener('click', (e) => { e.stopPropagation(); if (Date.now() - dragUp > 400 && addAt) openCompose(addAt, e.shiftKey); });

  // ---------- layers: in a narrow window, Contents, a sheet or Jump to over the view is a step in
  // the browser's history of its own, so the phone's Back closes it instead of leaving the view. A
  // view opened from it takes that step's place. A sheet's handle swipes it down.
  const LAYER = { entry: false, skip: false, soon: false };
  const SHEET_HANDLE = '<div class="sh-h" aria-hidden="true"></div>';
  const sheetsOpen = () => !!MENU.open || GH.reviewOpen || !!NT.agentOpen;
  function layerSoon() {
    if (LAYER.soon) return;
    LAYER.soon = true;
    queueMicrotask(() => {
      LAYER.soon = false;
      viewer.classList.toggle('sheet-on', compact() && sheetsOpen());
      const open = compact() && (SIDE.open || sheetsOpen() || PAL.open || viewer.classList.contains('composing'));
      if (LAYER.skip || !NAV.hist) return;
      try {
        if (open && !LAYER.entry) { history.pushState(Object.assign({}, history.state, { layer: 1 }), ''); LAYER.entry = true; }
        else if (!open && LAYER.entry) { LAYER.entry = false; LAYER.skip = true; history.back(); }
      } catch (err) { /* the browser limits how often */ }
    });
  }
  // Back with a layer open: the layer closes, and the view stays as it is.
  function layersClose() {
    LAYER.entry = false;
    if (SIDE.open) sideDrawer(false);
    if (PAL.open) palClose();
    if (MENU.open) closeMenu();
    if (NT.agentOpen) { NT.agentOpen = null; renderAgent(); }
    if (GH.reviewOpen) { GH.reviewOpen = false; render(); }
    if (state.compose && compact() && letGo(state.compose.key)) { state.compose = null; render(); }
  }
  // A sheet follows a finger down from its handle; let go far enough down, it closes.
  let sheetDrag = null;
  document.addEventListener('pointerdown', (e) => {
    const h = e.target instanceof Element && e.target.closest('.sh-h');
    const box = h && h.parentElement;
    if (!box) return;
    sheetDrag = { box, y: e.clientY, dy: 0, id: e.pointerId };
    h.setPointerCapture(e.pointerId);
  });
  document.addEventListener('pointermove', (e) => {
    if (!sheetDrag || e.pointerId !== sheetDrag.id) return;
    sheetDrag.dy = Math.max(0, e.clientY - sheetDrag.y);
    sheetDrag.box.style.transform = `translateY(${sheetDrag.dy}px)`;
  });
  // Let go short of that, it settles back up; far enough, it goes on down out of sight from where the
  // finger left it, as it closes, rather than coming back up to fade.
  const sliding = new WeakMap();
  const sheetLet = () => {
    if (!sheetDrag) return;
    const { box, dy } = sheetDrag;
    sheetDrag = null;
    box.style.transform = '';
    if (dy < 64) {
      if (dy && moving()) box.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 180, easing: EASE });
      return;
    }
    const away = moving() ? box.animate([{ transform: `translateY(${dy}px)` }, { transform: `translateY(${box.offsetHeight + 24}px)` }], { duration: 200, easing: EASE, fill: 'forwards' }) : null;
    if (away) sliding.set(box, away);
    if (box === MENU.el) closeMenu();
    else if (box.matches('.rv-pop')) { GH.reviewOpen = false; render(); }
    // The agent's card is drawn again as it closes: it goes once it's out of sight.
    else if (box.matches('.ag-pop')) {
      const close = () => { if (NT.agentOpen) { NT.agentOpen = null; renderAgent(); } };
      if (away) away.finished.then(close, () => {}); else close();
    }
  };
  const pointerLet = (e) => { if (sheetDrag && sheetDrag.id === e.pointerId) sheetLet(); };
  document.addEventListener('pointerup', pointerLet);
  document.addEventListener('pointercancel', pointerLet);
  // And down from anywhere else on it, when what's under the finger is scrolled to its top: a
  // finger that goes up, sideways, or down a list that has further up to go scrolls it instead. The
  // listener is the sheet's own (it has to be able to stop the scroll), so the view's scrolling
  // never waits on one.
  const sheetsTouched = new WeakSet();
  const atTop = (from, box) => { for (let n = from; n && n !== box.parentElement; n = n.parentElement) if (n.scrollTop > 0) return false; return true; };
  function sheetTouch(el) {
    if (sheetsTouched.has(el)) return;
    sheetsTouched.add(el);
    let t = null;
    el.addEventListener('touchstart', (e) => {
      const box = e.target instanceof Element && !e.target.closest('.sh-h') && e.target.closest('.menu.sheet, .rv-pop, .ag-pop');
      t = box && compact() && e.touches.length === 1 ? { box, x: e.touches[0].clientX, y: e.touches[0].clientY, top: atTop(e.target, box), on: false } : null;
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (!t) return;
      const p = e.touches[0], dx = p.clientX - t.x, dy = p.clientY - t.y;
      if (!t.on) {
        if (!(dy > 0 && dy >= Math.abs(dx) && t.top && e.cancelable)) { t = null; return; }
        t.on = true;
        sheetDrag = { box: t.box, y: p.clientY, dy: 0, id: 'touch' };
      }
      e.preventDefault();
      if (!sheetDrag) return;
      sheetDrag.dy = Math.max(0, p.clientY - sheetDrag.y);
      sheetDrag.box.style.transform = `translateY(${sheetDrag.dy}px)`;
    }, { passive: false });
    const end = () => { if (t && t.on && sheetDrag && sheetDrag.id === 'touch') sheetLet(); t = null; };
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
  }

  // ---------- picking lines, on a touch screen: a tap on a line's gutter picks it, and a tap on
  // another line's gutter in the same hunk stretches to it (as the +, dragged, does with a pointer).
  // The review bar turns into the lines' bar: Copy, Mark, and Note (or Comment) on them.
  const PICK = { path: null, a: null, b: null, view: '' };
  const rowKey = (row) => row.dataset.c || (row.dataset.n ? 'n:' + row.dataset.n : '');
  // The picked rows, in order, as the page has them now.
  function pickRows() {
    if (!PICK.path) return [];
    const codes = [...main.querySelectorAll('.code[data-p]')].filter((c) => c.dataset.p === PICK.path);
    for (const code of codes) {
      const rows = codeRun(code).flatMap((c) => [...c.querySelectorAll(':scope > .ln')]);
      let i = rows.findIndex((r) => rowKey(r) === PICK.a), j = rows.findIndex((r) => rowKey(r) === PICK.b);
      if (i < 0 || j < 0) continue;
      if (i > j) [i, j] = [j, i];
      return rows.slice(i, j + 1);
    }
    return [];
  }
  function paintPick() {
    const rows = new Set(pickRows());
    main.querySelectorAll('.cm-pick').forEach((x) => { if (!rows.has(x)) x.classList.remove('cm-pick'); });
    rows.forEach((x) => x.classList.add('cm-pick'));
    if (PICK.path && !rows.size) pickClear();
  }
  function pickClear() {
    if (!PICK.path) return;
    PICK.path = PICK.a = PICK.b = null;
    main.querySelectorAll('.cm-pick').forEach((x) => x.classList.remove('cm-pick'));
    renderPill();
  }
  const hunkOf = (path, row) => { const [sd, line] = (row.dataset.c || '').split(':'); const r = line ? rowAt(path, sd === 'L' ? 'LEFT' : 'RIGHT', Number(line)) : null; return r ? r.hi : null; };
  main.addEventListener('click', (e) => {
    if (!COARSE.matches || !(e.target instanceof Element)) return;
    const cell = e.target.closest('.ln > .g, .ln > .no, .ln > .sg');
    if (!cell || e.target.closest('button:not(.tick), a')) return;
    const row = cell.parentElement, code = row.closest('.code[data-p]');
    if (!code || !rowKey(row)) return;
    e.stopPropagation();
    const path = code.dataset.p, key = rowKey(row);
    const rows = pickRows();
    if (PICK.path === path && rows.length === 1 && rows[0] === row) return pickClear();
    if (PICK.path === path && rows.length && codeRun(code).includes(rows[0].closest('.code')) && hunkOf(path, rows[0]) === hunkOf(path, row)) PICK.b = key;
    else Object.assign(PICK, { path, a: key, b: key, view: viewKey() });
    paintPick();
    renderPill();
  }, true);
  // The lines' bar, in the review bar's place.
  function pickBarHtml() {
    const rows = pickRows();
    const nos = rows.map((r) => (r.querySelector(':scope > .no') || {}).textContent).filter(Boolean);
    const what = nos.length > 1 ? `Lines ${nos[0]}–${nos[nos.length - 1]}` : nos.length ? `Line ${nos[0]}` : `${rows.length} lines`;
    const can = canCommentLines() && rows.some((r) => r.dataset.c);
    const local = localMode();
    return `${iconBtn(ICON.close, 'Put the lines back', 'data-act="pick-clear"')}<span class="pick-what"><b>${esc(what)}</b><small>${esc(fileName(PICK.path))}</small></span><span class="sp"></span>`
      + iconBtn(ICON.copy, 'Copy the lines', 'data-act="pick-copy"') + (pickBlocks().length ? iconBtn(ICON.check, 'Mark their changes reviewed', 'data-act="pick-mark"') : '')
      + (can ? `<button type="button" class="pill-act pick-note${local ? ' local' : ''}" data-act="pick-note">${ICON.comment}${local ? 'Note' : 'Comment'}</button>` : '');
  }
  // The changes the picked rows are in: the marks among them, else the one their run starts with.
  function pickBlocks() {
    const rows = pickRows();
    const ids = new Set(rows.flatMap((r) => [...r.querySelectorAll('.tick[data-block]')].map((t) => t.dataset.block)));
    if (!ids.size && rows.length) {
      for (let r = rows[0]; r && r.matches('.ln.add, .ln.del'); r = r.previousElementSibling) {
        const t = r.querySelector('.tick[data-block]');
        if (t) { ids.add(t.dataset.block); break; }
      }
    }
    return blocksOf([...ids]);
  }
  function pickAct(act) {
    const rows = pickRows();
    if (act === 'pick-clear') return pickClear();
    if (act === 'pick-copy') { copyText(rows.map((r) => (r.querySelector(':scope > .tx') || {}).textContent || '').join('\n'), `Copied ${plural(rows.length, 'line')}.`); return pickClear(); }
    if (act === 'pick-mark') { const bl = pickBlocks(); toggleBlocks(bl); hint({ mark: bl.map((b) => b.id) }); pickClear(); return render(); }
    if (act === 'pick-note') {
      const path = PICK.path, cells = rows.filter((r) => r.dataset.c), at = (r) => { const [sd, line] = r.dataset.c.split(':'); return { path, side: sd === 'L' ? 'LEFT' : 'RIGHT', line: Number(line) }; };
      if (!cells.length) return;
      PICK.path = PICK.a = PICK.b = null;
      main.querySelectorAll('.cm-pick').forEach((x) => x.classList.remove('cm-pick'));
      return composeRange(at(cells[0]), at(cells[cells.length - 1]));
    }
  }
  // The box you write in, in a narrow window: a sheet held at the bottom of what's visible, over
  // the keyboard (Safari doesn't shrink the page for it; visualViewport says where it is). The view
  // above it keeps its lines in sight.
  let composeLast = '';
  function renderCompose() {
    const host = $('#vw-compose');
    if (!host) return;
    const c = compact() && state.compose && (GH.on || NT.on) ? state.compose : null;
    const h = c ? newThreadHtml(c) : '';
    viewer.classList.toggle('composing', !!h);
    if (h === composeLast) return;
    const opening = !composeLast && h;
    composeLast = h;
    host.innerHTML = h;
    host.style.setProperty('--h', host.offsetHeight + 'px');
    viewer.style.setProperty('--compose-h', host.offsetHeight + 'px');
    if (opening) requestAnimationFrame(composeInView);
    layerSoon();
  }
  function composeInView() {
    if (!viewer.classList.contains('composing')) return;
    const sel = main.querySelectorAll('.cm-sel');
    const last = sel[sel.length - 1];
    if (last) placeRow(last, Math.max(8, main.clientHeight - last.offsetHeight - 12));
  }
  const VV = window.visualViewport;
  function keyboardInset() {
    if (!VV) return;
    const kb = Math.max(0, Math.round(window.innerHeight - VV.height - VV.offsetTop));
    document.documentElement.style.setProperty('--kb', kb + 'px');
    document.documentElement.style.setProperty('--vvh', Math.round(VV.height) + 'px');
    document.documentElement.style.setProperty('--vvt', Math.round(VV.offsetTop) + 'px');
    const host = $('#vw-compose');
    if (host && host.childElementCount) viewer.style.setProperty('--compose-h', host.offsetHeight + 'px');
    composeInView();
  }
  if (VV) { VV.addEventListener('resize', keyboardInset); VV.addEventListener('scroll', keyboardInset); keyboardInset(); }

  // ---------- going back: each view the page moves to is a step in the browser's history, so Back
  // (the header's arrow, the browser's, Alt ←, a mouse's back button) brings back the view before,
  // scrolled where it was, with its sidebar tab. Without the browser's history, the steps are the
  // page's alone.
  const NAV = { stack: [], at: -1, hist: true, saveT: 0 };
  const BACK_KEY = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘[' : 'Alt ←';
  const navKey = (v) => [v.kind, v.id, v.path, v.family, v.side, v.ext, v.commit].join('|');
  const navState = (e) => ({ untangle: 1, at: e.at, view: e.view, tab: e.tab, top: e.top, name: e.name });
  // What a view is called, on the button that goes back to it.
  function viewName(v) {
    const m = M();
    if (v.kind === 'chain') return m.chains[v.id] ? m.chains[v.id].name : 'the chain';
    if (v.kind === 'file') return fileName(v.path);
    if (v.kind === 'source') return v.ext != null ? v.label || 'the file' : fileName(v.path || '');
    return { map: 'the chain map', standalone: 'Not in a chain', group: 'the same change', search: 'the search', conversation: 'the conversation', history: 'History', tests: 'Tests' }[v.kind] || 'the view before';
  }
  // As a render starts: a view that isn't the step's is a new step, and the step it leaves keeps
  // where it was scrolled.
  function navStep(keep) {
    const key = navKey(state.view), cur = NAV.stack[NAV.at];
    if (cur && cur.key === key) { cur.view = state.view; cur.tab = state.tab; return; }
    if (cur) { cur.top = keep; navSave(cur); }
    NAV.stack.length = NAV.at + 1;
    const e = { key, at: NAV.at + 1, view: state.view, tab: state.tab, top: 0, name: viewName(state.view) };
    try {
      if (e.at === 0) {
        // The page's first step: after a reload, the steps behind it are still the browser's.
        const s0 = history.state;
        if (s0 && s0.untangle && s0.at > 0) e.at = s0.at;
        history.replaceState(navState(e), '');
      } else if (NAV.hist && LAYER.entry) { history.replaceState(navState(e), ''); LAYER.entry = false; } else if (NAV.hist) history.pushState(navState(e), '');
    } catch (err) { NAV.hist = false; }
    NAV.stack[e.at] = e;
    NAV.at = e.at;
  }
  // A step's place, kept in the browser's history while it's the step there.
  function navSave(e) {
    try { if (NAV.hist && history.state && history.state.untangle && history.state.at === e.at) history.replaceState(navState(e), ''); } catch (err) { /* the browser limits how often */ }
  }
  // The view a step was, as this page has it now: a chain by its name, a file that's still here.
  function navView(st) {
    const v = st.view, m = M();
    if (!v || !v.kind) return null;
    if (v.kind === 'chain') { const c = m.chains[v.id] && m.chains[v.id].name === st.name ? m.chains[v.id] : m.chains.find((x) => x.name === st.name); return c ? { kind: 'chain', id: c.id } : null; }
    if (v.kind === 'file') return m.files.some((f) => f.p === v.path) || m.generated.some((f) => f.p === v.path) ? v : null;
    if (v.kind === 'group') return m.groupById.has(Number(v.id)) ? v : null;
    if (v.kind === 'map') return v.family == null || m.families.some((f) => f.id === v.family) ? v : { kind: 'map', family: null };
    if (v.kind === 'history') return HX ? v : null;
    if (v.kind === 'conversation') return GH.on ? v : null;
    return v;
  }
  function navGo(st) {
    const v = navView(st);
    const cur = NAV.stack[NAV.at];
    if (cur) cur.top = main.scrollTop;
    NAV.at = st.at;
    if (v) { state.view = v; state.peek = null; state.focus = null; if (st.tab) state.tab = st.tab; }
    NAV.stack[st.at] = { key: navKey(state.view), at: st.at, view: state.view, tab: state.tab, top: st.top || 0, name: st.name };
    render(v ? { scroll: st.top || 0 } : {});
  }
  function navBack() {
    if (NAV.at <= 0) return;
    if (NAV.hist) return history.back();
    const prev = NAV.stack[NAV.at - 1];
    if (prev) navGo(navState(prev));
  }
  window.addEventListener('popstate', (e) => {
    if (LAYER.skip) { LAYER.skip = false; return layerSoon(); }
    if (LAYER.entry) return layersClose();
    if (e.state && e.state.untangle && e.state.view) navGo(e.state);
  });
  const navBackHtml = () => {
    if (NAV.at <= 0) return '';
    const to = NAV.stack[NAV.at - 1];
    return `<button type="button" class="ib fv-back" data-act="back" title="${esc(`Back to ${to && to.name ? to.name : 'where you were'} (${BACK_KEY})`)}" aria-label="Back">${ICON.back}</button>`;
  };

  // ---------- views
  const SEP = '<span class="sep" aria-hidden="true">/</span>';
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  // A folder's path in a breadcrumb: its last folders, when it's long.
  function shortDir(dir) {
    if (dir.length <= 44) return dir;
    const parts = dir.split('/');
    let out = parts.pop();
    while (parts.length && out.length + parts[parts.length - 1].length < 40) out = parts.pop() + '/' + out;
    return '…/' + out;
  }
  // A file's folders, each a button listing the files in it, as a folder of GitHub's breadcrumbs
  // opens. The first ones, when they're long, fold into "…": the deepest of them. Squeezed, the
  // farthest give way first, each before the next (--far). The repository's files are asked for
  // as they show, to be there when a folder opens.
  const fileCrumbs = (p) => {
    repoFiles();
    const dirs = p.split('/').slice(0, -1), short = shortDir(dirs.join('/'));
    const hide = short.startsWith('…/') ? dirs.length - short.split('/').length + 1 : 0;
    const crumb = (k, label) => `<button type="button" data-act="menu" data-menu="crumb:${k}" aria-haspopup="menu" aria-expanded="${MENU.open === 'crumb:' + k}" ${label === '…' ? 'class="fold"' : `style="--far:${10 ** Math.min(6, dirs.length - 1 - k)}"`} title="${esc(dirs.slice(0, k + 1).join('/'))}/: the files in it">${esc(label)}</button>`;
    const path = (hide ? [crumb(hide - 1, '…')] : []).concat(dirs.slice(hide).map((d, i) => crumb(hide + i, d))).join('<i>/</i>');
    return `<button type="button" data-tab="files" title="Show the files">Files</button>${SEP}${dirs.length ? `<span class="path">${path}</span>${SEP}` : ''}<b title="${esc(p)}">${esc(fileName(p))}</b>`;
  };
  // A file's path, its folders and its name apart: a narrow window shows the name first.
  const pathHtml = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? `<span class="pname">${esc(p)}</span>` : `<span class="pdir">${esc(p.slice(0, i + 1))}</span><span class="pname">${esc(p.slice(i + 1))}</span>`; };
  // A chain's name with its owner apart: "BridgeMcpServer." and "logPath".
  const splitName = (name) => { const m = /^(_?[A-Z][\w$]*\.)(.+)$/.exec(name); return m ? { own: m[1], name: m[2] } : { own: '', name }; };
  // A commit's chain, and the step that gathers a commit's other changes, are named in words.
  const proseName = (c) => c.kind === 'commit';
  // What's left to review of a set of changes, in words.
  // Under a lens, a scope with nothing in it: no mark, no action, "nothing in the lens".
  const outOfLens = (st) => lensOn() && !st.total;
  const leftWords = (s) => (!s.total ? (lensOn() ? 'nothing in the lens' : 'no changes') : !s.open ? (s.total === 1 ? 'its change reviewed' : `all ${s.total} changes reviewed`) : s.open === s.total ? `${s.total} change${s.total === 1 ? '' : 's'}` : `${s.open} of ${s.total} to review`);
  const plusMinus = (a, d) => `<span class="a">+${fmt(a)}</span> <span class="d">−${fmt(d)}</span>`;
  const sumOf = (blocks, k) => blocks.reduce((x, b) => x + b[k], 0);
  // A view's header, in one row: where you are, what it holds, what it says about where you are in
  // it (`lead`), the previous and next change, the view's own toggles (`tools`), its menu (⋯) and its
  // one action. `pinned`: what stays on screen under it (a chain's commits); `below`: what follows
  // it, scrolling away with the code.
  function headerHtml(o) {
    const nav = o.nav ? iconBtn(ICON.up, 'Previous change', 'data-act="nav" data-step="-1"') + iconBtn(ICON.down, 'Next change', 'data-act="nav" data-step="1"') : '';
    const menu = viewMenuItems().length ? `<button type="button" class="ib" data-act="menu" data-menu="view" title="More" aria-label="More" aria-haspopup="menu" aria-expanded="${MENU.open === 'view'}">${ICON.more}</button>` : '';
    return `<div class="fv-head"><div class="fv-row"><nav class="crumbs" aria-label="Where you are">${navBackHtml()}${o.crumbs}</nav>${o.facts ? `<span class="facts">${o.facts}</span>` : ''}${o.chip || ''}${lensOfferHtml()}<span class="sp"></span>${o.lead || ''}${nav || o.tools || menu ? `<span class="tools">${nav}${o.tools || ''}${menu}</span>` : ''}${o.action || ''}</div>${o.pinned || ''}</div>${o.below || ''}`;
  }
  function instancesHtml(g, blocks, key) {
    const list = blocks || g.edits.map((id) => M().blockById.get(M().edits[id].b)).filter((b, i, arr) => arr.indexOf(b) === i);
    const showAll = state.groupAll.has(key) || list.length <= 12;
    const shown = showAll ? list : list.slice(0, 10);
    let h = '<div class="code inst">';
    let lastFile = null;
    shown.forEach((b) => {
      const f = b.file;
      const hunk = f.hunks[b.hunk];
      if (f !== lastFile) { h += `<div class="inst-file"><button type="button" class="linkish" data-open="${esc(f.p)}">${pathHtml(f.p)}</button></div>`; lastFile = f; }
      // Each edit's rows, extended to its whole syntax nodes, with one line of context.
      // Small changes are shown whole.
      const keep = new Set();
      if (b.len <= 8) for (let i = b.first; i < b.first + b.len; i++) keep.add(i);
      g.edits.forEach((id) => {
        const ed = M().edits[id];
        if (ed.b !== b.id) return;
        hunk.meta.forEach((r, i) => {
          if ((ed.ns && r.n != null && r.t !== '-' && r.n >= ed.ns[0] && r.n <= ed.ns[1]) || (ed.os && r.o != null && r.t !== '+' && r.o >= ed.os[0] && r.o <= ed.os[1])) keep.add(i);
        });
      });
      const wide = new Set();
      keep.forEach((i) => { for (let k = i - 1; k <= i + 1; k++) if (k >= 0 && k < hunk.rows.length) wide.add(k); });
      const idx = [...wide].sort((x, y) => x - y);
      let segStart = idx[0];
      for (let k = 1; k <= idx.length; k++) {
        if (k === idx.length || idx[k] !== idx[k - 1] + 1) {
          h += anyRowsHtml(f, b.hunk, segStart, idx[k - 1] + 1, { noBadges: true });
          if (k < idx.length) { h += `<div class="ln skip"><span class="g"></span><span class="no"></span><span class="sg"></span><span class="tx">${idx[k] - idx[k - 1] - 1} more lines of the same change</span></div>`; segStart = idx[k]; }
        }
      }
      h += '<div class="inst-gap"></div>';
    });
    h += '</div>';
    if (!showAll) h += `<div class="more-row"><button type="button" class="btn sm" data-act="group-all" data-key="${esc(key)}">Show all ${list.length} places</button></div>`;
    return h;
  }
  // The order chains are reviewed in: families as the sidebar lists them (each by level), then
  // unlinked chains, then the changes outside chains.
  function chainOrder() {
    const m = M();
    if (m.byCommit) return m.families.flatMap((f) => f.chains).map((c) => c.id);
    const linked = m.families.filter((f) => f.chains.length > 1).flatMap((f) => f.chains);
    const lone = m.families.filter((f) => f.chains.length === 1).map((f) => f.chains[0]).sort((x, y) => y.blocks.length - x.blocks.length);
    return linked.concat(lone).map((c) => c.id);
  }
  // The next chain with changes to review (step -1: the previous one), in that order; the changes
  // outside chains once no chain has any.
  function nextUnreviewed(step) {
    step = step || 1;
    const m = M();
    const order = chainOrder();
    const at = state.view.kind === 'chain' ? order.indexOf(state.view.id) : step > 0 ? -1 : order.length;
    for (let k = 1; k <= order.length; k++) {
      const id = order[(((at + step * k) % order.length) + order.length) % order.length];
      if (stats(blocksOf(m.chains[id].blocks)).open) return { kind: 'chain', id };
    }
    return stats(m.standalone).open && state.view.kind !== 'standalone' ? { kind: 'standalone' } : null;
  }
  // ---------- tests as sentences
  // A test file's group and test calls (the analysis's outline), read as the sentences they assert:
  // a test's sentence is the titles from its outermost group down to it. An outline shows what a
  // scope changed (a chain's blocks, or the whole review) with every group that completes each
  // sentence; the groups that didn't change are dimmed. A row opens its code in place: a test its
  // body, a group its own lines with its calls folded to their titles. A test's mark covers its
  // body; a group's, its setup and everything under it.
  const OL_KW = /^(Given|given|When|when|Then|then)$/;
  // A title's words, the clause words marked and, for a rewording, the words that changed.
  function olWords(now, was) {
    const tok = (s) => s.trim().split(/(\s+)/).filter((x) => x !== '');
    const B = tok(now);
    let ops = B.map((x) => ['=', x]);
    if (was != null) {
      const A = tok(was);
      const L = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
      for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      ops = [];
      let i = 0, j = 0;
      while (i < A.length && j < B.length) {
        if (A[i] === B[j]) { ops.push(['=', B[j]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) ops.push(['-', A[i++]]); else ops.push(['+', B[j++]]);
      }
      while (i < A.length) ops.push(['-', A[i++]]);
      while (j < B.length) ops.push(['+', B[j++]]);
    }
    let h = '', prev = '', run = null, buf = '';
    // A run of changed words is marked as one, without the space that follows it.
    const flush = () => { const m = /^([\s\S]*?)(\s*)$/.exec(buf); h += run === '+' ? `<ins>${m[1]}</ins>${m[2]}` : run === '-' ? `<del>${m[1]}</del>${m[2]}` : buf; buf = ''; };
    for (const [op, x] of ops) {
      const space = /^\s+$/.test(x);
      const kw = !space && op !== '-' && OL_KW.test(x) && (prev === '' || /,$/.test(prev));
      const want = space ? run : op === '=' ? null : op;
      if (want !== run) { flush(); run = want; }
      buf += kw ? `<b class="kw">${esc(x)}</b>` : esc(x);
      if (!space && op !== '-') prev = x;
    }
    flush();
    return h;
  }
  // The outline, linked: each call with its parent, children and depth.
  function olOf(f) {
    if (!f || !f.outline) return null;
    if (f.ol) return f.ol;
    const nodes = f.outline.nodes.map((n, i) => ({ ...n, i, kids: [], parent: null, depth: 0 }));
    nodes.forEach((n) => { if (n.p != null) { n.parent = nodes[n.p]; n.parent.kids.push(n); } });
    nodes.forEach((n) => { for (let x = n.parent; x; x = x.parent) n.depth++; });
    const removed = (f.outline.removed || []).map((r, j) => ({ ...r, j, parent: r.p != null ? nodes[r.p] : null, removed: true }));
    return (f.ol = { nodes, top: nodes.filter((n) => !n.parent), removed });
  }
  const olPath = (n) => { const out = []; for (let x = n; x; x = x.parent) out.unshift(x); return out; };
  const olKey = (f, n) => f.p + '#' + (n.removed ? 'r' + n.j : n.i);
  const olStatus = (s) => (s === 'new' ? 'new' : s === 'reworded' || s === 'renamed' ? 'rew' : s === 'regrouped' ? 'reg' : '');
  const OL_MARK = { new: '+', rew: '~', reg: '↳' };
  // A test's expect calls, muted, shown with its lines while the row is hovered.
  const olExpects = (n) => (n.k === 't' && n.x != null ? `<span class="ol-xp" title="${n.x ? `${plural(n.x, 'expect call')} in this test` : 'No expect call in this test'}">${n.x ? plural(n.x, 'expect') : 'no expect'}</span>` : '');
  // A Given or a when without setUp or setUpAll: a red dot after its title.
  const olNoSetup = (n) => {
    const w = n.k !== 't' && !n.l && !n.su && /^\s*(given|when)\b/i.exec(n.t);
    return w ? `<i class="ol-nosu" title="No setUp or setUpAll in this ${/^g/i.test(w[1]) ? 'Given' : 'when'}"></i>` : '';
  };
  // The diff's lines in a call's whole range, on both sides (in a chain, the chain's), shown while
  // the row is hovered.
  function olDiff(sc, n) {
    const f = sc.f;
    let a = 0, d = 0;
    const count = (meta, from, to) => {
      for (let i = from; i < to; i++) {
        const r = meta[i];
        if (r.t === '+' && n.s != null && r.n >= n.s && r.n <= n.e) a++;
        else if (r.t === '-' && n.os != null && r.o >= n.os && r.o <= n.oe) d++;
      }
    };
    if (sc.chain) f.blocks.forEach((b) => { if (sc.chain.blockSet.has(b.id)) count(hunkMeta(f.hunks[b.hunk]), b.first, b.first + b.len); });
    else f.hunks.forEach((h) => { const meta = hunkMeta(h); count(meta, 0, meta.length); });
    if (!a && !d) return '';
    return `<span class="ol-df" title="The lines ${n.removed ? 'it removed' : `this ${n.k === 't' ? 'test' : 'group'} changed`}">${[a ? `<span class="a">+${fmt(a)}</span>` : '', d ? `<span class="d">−${fmt(d)}</span>` : ''].filter(Boolean).join(' ')}</span>`;
  }
  // What a scope changed in a file's outline: each call's status there and its blocks, the calls to
  // show (what it changed, and the groups above), the calls it removed, the calls whose code it
  // edited under a sentence that stayed, and its blocks outside every call.
  function olScope(f, chain) {
    const ol = olOf(f);
    const block = (k) => f.blocks[k];
    const live = (b) => !!b && b.edits.length > 0 && (!chain || chain.blockSet.has(b.id));
    const blocks = (ks) => (ks || []).map(block).filter(live);
    const st = new Map();
    for (const n of ol.nodes) {
      const own = (n.own || []).filter(([k]) => live(block(k)));
      const head = blocks(n.head).length > 0;
      const via = n.k === 't' && olPath(n).slice(0, -1).some((g) => g.st === 'renamed' && blocks(g.head).length > 0);
      let s = null;
      if (n.k === 't') {
        if (n.st === 'new' && (own.length || head)) s = 'new';
        else if (n.st === 'reworded' && (head || via)) s = 'reworded';
        else if (n.st === 'regrouped' && (own.length || head || via)) s = 'regrouped';
        else if (own.length) s = 'edited';
      } else if (n.l) s = own.length ? 'edited' : null;
      else if (n.st === 'new' && (head || (!chain && own.length))) s = 'new';
      else if (n.st === 'renamed' && head) s = 'renamed';
      else if (own.length) s = 'edited';
      const mine = [...new Set(own.map((o) => o[0]).concat(n.head || []))];
      st.set(n, { s, adds: own.reduce((x, o) => x + o[1], 0), dels: own.reduce((x, o) => x + o[2], 0), setup: own.length > 0, own: blocks(mine), all: blocks(n.b) });
    }
    const show = new Set();
    const up = (n) => { for (let x = n; x; x = x.parent) show.add(x); };
    const primary = (n) => ['new', 'reworded', 'regrouped', 'renamed'].includes(st.get(n).s);
    ol.nodes.forEach((n) => { if (primary(n)) up(n); });
    // A group the scope wrote or renamed brings its tests along: it wrote part of their sentences.
    ol.nodes.forEach((g) => { if (g.k !== 't' && primary(g)) ol.nodes.forEach((n) => { if (n.k === 't' && olPath(n).includes(g)) up(n); }); });
    const rm = ol.removed.filter((r) => blocks(r.b).length > 0);
    rm.forEach((r) => up(r.parent));
    const edited = ol.nodes.filter((n) => !show.has(n) && st.get(n).s === 'edited');
    const outside = blocks(f.outline.out);
    return { f, ol, chain, st, show, rm, edited, outside, any: show.size > 0 || rm.length > 0 };
  }
  function olCounts(sc) {
    const c = { new: 0, reworded: 0, regrouped: 0, removed: 0 };
    sc.show.forEach((n) => { const s = sc.st.get(n).s; if (n.k === 't' && c[s] != null) c[s]++; });
    sc.rm.forEach((r) => { c.removed += r.leaves.length; });
    return c;
  }
  const olSaid = (c) => [c.new && `${c.new} new`, c.reworded && `${c.reworded} reworded`, c.regrouped && `${c.regrouped} regrouped`, c.removed && `${c.removed} removed`].filter(Boolean).join(' · ');
  // The chain that wrote a call's title: a commit's before a rename's.
  function olWriter(f, n) {
    const m = M();
    for (const k of n.head || []) {
      const b = f.blocks[k];
      const ids = (b && m.chainsOf.get(b.id)) || [];
      const best = ids.map((id) => m.chains[id]).sort((x, y) => (x.kind === 'commit' ? 0 : 1) - (y.kind === 'commit' ? 0 : 1) || x.id - y.id)[0];
      if (best) return best;
    }
    return null;
  }
  function chainSha(c) {
    const m = M();
    const fam = m.byCommit && c.kind === 'commit' ? m.families.find((x) => x.id === c.family) : null;
    return fam && fam.commit ? fam.commit.sha : null;
  }
  // hover: shown with the row's other details, as in the Tests view, where most rows have one.
  const olChip = (c, key, hover) => { const sha = chainSha(c); return `<button type="button" class="ol-chip${hover ? ' ol-hov' : ''}" data-act="ol-chain" data-chain-id="${c.id}" data-ol="${esc(key)}" title="Written in ${esc(c.name)}: open it there">${sha ? `<code>${esc(shortSha(sha))}</code>` : esc(trunc(c.name, 28))}</button>`; };
  // Whether a fold of an outline is open: code is open by default in a chain (it's the chain's code)
  // and closed in the Tests view; a click flips it.
  const olFold = (sc, key) => (sc.chain ? !state.olUnfold.has(key + '@' + sc.chain.id) : state.olUnfold.has(key));
  const olFoldKey = (sc, key) => (sc.chain ? key + '@' + sc.chain.id : key);
  const olTag = (html, title) => `<span class="ol-tag"${title ? ` title="${esc(title)}"` : ''}>${html}</span>`;
  const olPm = (a, d) => `<span class="a">+${fmt(a)}</span>${d ? ` <span class="d">−${fmt(d)}</span>` : ''}`;

  // Where a line of the file sits in its stream of rows (see streamOf), on the new or the old side.
  function olPos(f, line, old) {
    const st = streamOf(f);
    for (const g of st.segs) {
      if (g.gap) { const first = old ? g.o : g.n; if (line >= first && line < first + g.size) return g.at + line - first; continue; }
      const meta = hunkMeta(f.hunks[g.hi]);
      for (let ri = 0; ri < meta.length; ri++) {
        const r = meta[ri];
        if (old ? r.t !== '+' && r.o === line : r.t !== '-' && r.n === line) return g.at + ri;
      }
    }
    return st.at + line - (old ? st.o : st.n);
  }
  // The removed rows of a file, as [old line, place in its stream].
  function olGone(f) {
    if (f.olGone) return f.olGone;
    const out = [];
    streamOf(f).segs.forEach((g) => { if (!g.gap) hunkMeta(f.hunks[g.hi]).forEach((r, ri) => { if (r.t === '-') out.push([r.o, g.at + ri]); }); });
    return (f.olGone = out);
  }
  // Whether a row of a file's stream is blank, when that's known: a hunk's rows always, the lines
  // between hunks once the file has loaded.
  function olBlank(f, at) {
    const st = streamOf(f), g = segAt(st, at);
    if (g && !g.gap) return !f.hunks[g.hi].rows[at - g.at][1].trim();
    const s = sources.get(srcKey({ side: 'head', path: f.p }));
    const line = s && s.status === 'ok' ? s.lines[(g ? g.n + at - g.at : st.n + at - st.at) - 1] : null;
    return line != null && !line.trim();
  }
  // A call's own code: its lines and the lines it removed, without the calls under it, which fold
  // to their titles. Blank lines are never shown on their own.
  function olCodeHtml(sc, n) {
    const f = sc.f;
    const ctx = { key: 'ol|' + olKey(f, n), chain: sc.chain || undefined };
    let h = '';
    if (n.removed) {
      const a = olPos(f, n.os, true), b = olPos(f, n.oe, true);
      h = streamRowsHtml(f, a, b + 1, ctx);
    } else {
      const kids = n.k === 't' ? [] : n.kids;
      const under = (line, ranges) => ranges.some(([a, b]) => line >= a && line <= b);
      const ranges = kids.map((k) => [k.s, k.e]);
      // Each place in the stream: a row of its own (null), or a call under it, folded.
      const at = new Map();
      for (let line = n.s; line <= n.e; line++) if (!under(line, ranges)) at.set(olPos(f, line, false), null);
      if (n.os != null) olGone(f).forEach(([o, pos]) => { if (o >= n.os && o <= n.oe && !under(o, n.ok || [])) at.set(pos, null); });
      kids.forEach((k) => at.set(olPos(f, k.s, false), k));
      let run = [];
      const flush = () => { if (run.length && !run.every((pos) => olBlank(f, pos))) h += streamRowsHtml(f, run[0], run[run.length - 1] + 1, ctx); run = []; };
      [...at.keys()].sort((x, y) => x - y).forEach((pos) => {
        const kid = at.get(pos);
        if (kid) {
          flush();
          h += `<div class="ln ol-ph"><span class="g"></span><span class="no">${kid.s}</span><span class="sg"></span><span class="tx"><span class="ol-ph-t">${kid.l ? esc(kid.t) : olWords(kid.t)}</span><span class="ol-ph-n">${linesWord(kid.e - kid.s + 1)}</span></span></div>`;
          return;
        }
        if (run.length && pos !== run[run.length - 1] + 1) flush();
        run.push(pos);
      });
      flush();
    }
    return `<div class="code ol-code" data-p="${esc(f.p)}" style="--d:${n.removed ? (n.parent ? n.parent.depth + 1 : 0) : n.depth}">${h}</div>`;
  }
  // One call's row. o.chips: name the chain that wrote what this row shows as changed (the Tests
  // view); in a chain, groups another chain wrote name it.
  function olRowHtml(sc, n, o) {
    const f = sc.f, s = sc.st.get(n) || { s: null, own: [], all: [] };
    const key = olKey(f, n);
    const test = n.k === 't';
    const cls = olStatus(s.s) || (test && s.s === 'edited' ? 'edit' : 'ctx');
    const was = n.ot != null && (s.s === 'renamed' || s.s === 'reworded') ? n.ot : null;
    const tags = [];
    if (s.s === 'regrouped') tags.push(olTag('regrouped', `The same sentence, in a new group. It read: ${n.was || ''}`));
    if (s.s === 'reworded') tags.push(olTag(was ? 'reworded' : 'reworded above', `It read: ${n.was || ''}`));
    if (!test && s.setup && s.s !== 'new') tags.push(olTag(`setup ${olPm(s.adds, s.dels)}`, 'Its own lines changed: its setup, without its title and the calls under it'));
    const body = test && s.s === 'edited';
    if (body) tags.push(olTag(`body ${olPm(s.adds, s.dels)}`, 'Its body changed; its sentence didn’t'));
    const shown = s.s === 'new' || s.s === 'renamed' || (s.s === 'reworded' && was);
    const writer = (o.chips && shown) || (sc.chain && !shown) ? olWriter(f, n) : null;
    const chip = writer && (!sc.chain || (writer.id !== sc.chain.id && !(sc.chain.sha && chainSha(writer) === sc.chain.sha))) ? olChip(writer, key, o.chips) : '';
    const marks = s.s ? s.all : [];
    const st = stats(marks), todo = stats(s.own).open > 0;
    const open = state.olOpen.has(key);
    // A group partly reviewed: its mark shows a dash, and its title mutes once its own lines are.
    const part = !test && st.open > 0 && st.open < st.total;
    const tick = marks.length && !outOfLens(st) ? olTickHtml(marks, st, test ? 'Mark this test reviewed' : part ? `Mark the rest of this group reviewed (${st.open} of ${st.total} to review)` : 'Mark this group reviewed: its setup and everything under it') : '<span class="ol-tick-sp"></span>';
    const nav = s.own.length ? ` data-mark="${esc(s.own.map((b) => b.id).join(' '))}" data-block="${esc(s.own[0].id)}"${todo ? ' data-nav="1"' : ''}` : '';
    const muted = marks.length && (!st.open || (!test && s.own.length && !todo));
    return `<div class="ol-row ${cls}${n.l ? ' lbl' : ''}${open ? ' open' : ''}${muted ? ' done' : ''}" data-act="ol-open" data-ol="${esc(key)}"${nav} style="--d:${n.depth}" role="button" tabindex="0" aria-expanded="${open}">`
      + `<span class="ol-mk" aria-hidden="true">${OL_MARK[cls] || ''}</span>`
      + `<span class="ol-tt">${n.l ? esc(n.t) : olWords(n.t, was)}${olNoSetup(n)}</span>`
      + `<span class="ol-meta">${olExpects(n)}${body ? '' : olDiff(sc, n)}${chip}<button type="button" class="ol-go" data-open="${esc(f.p)}" data-line="${n.s}" title="Open in the file, at line ${n.s}" aria-label="Open in the file">${ICON.intoFile}</button>${tags.join('')}${tick}</span></div>`
      + (open ? olCodeHtml(sc, n) : '');
  }
  // A review mark for what a row covers: on when all of it is reviewed, a dash when some of it is.
  function olTickHtml(marks, st, title) {
    const part = st.open > 0 && st.open < st.total;
    return `<button type="button" class="tick ol-tick${st.open ? (part ? ' part' : '') : ' on'}" data-act="mark-blocks" data-blocks="${esc(marks.map((b) => b.id).join(' '))}" title="${esc(st.open ? title : 'Mark unreviewed')}" aria-pressed="${st.open ? (part ? 'mixed' : 'false') : 'true'}"></button>`;
  }
  // A file's mark: every change in it, or in a chain (or a commit), every change of the chain's.
  const olFileMarks = (sc) => sc.f.blocks.filter((b) => b.edits.length && (!sc.chain || sc.chain.blockSet.has(b.id)));
  function olFileTickHtml(sc, marks, st) {
    if (!st.total || outOfLens(st)) return '<span class="ol-tick-sp"></span>';
    return olTickHtml(marks, st, `Mark this file reviewed: ${!sc.chain ? 'every change in it' : `its changes in this ${sc.chain.sha ? 'commit' : 'chain'}`}`);
  }
  // What a removed call's mark covers.
  const olGoneMarks = (sc, r) => (r.b || []).map((k) => sc.f.blocks[k]).filter((b) => b && b.edits.length && (!sc.chain || sc.chain.blockSet.has(b.id)));
  function olRemovedHtml(sc, r) {
    const f = sc.f, key = olKey(f, r);
    const d = r.parent ? r.parent.depth + 1 : 0;
    const marks = olGoneMarks(sc, r);
    const st = stats(marks), open = state.olOpen.has(key);
    const prefix = r.parent ? olPath(r.parent).filter((x) => !x.l).map((x) => x.t.trim()).join(' ').length + 1 : 0;
    let h = `<div class="ol-row del${open ? ' open' : ''}${marks.length && !st.open ? ' done' : ''}" data-act="ol-open" data-ol="${esc(key)}"${marks.length ? ` data-mark="${esc(marks.map((b) => b.id).join(' '))}" data-block="${esc(marks[0].id)}"${st.open ? ' data-nav="1"' : ''}` : ''} style="--d:${d}" role="button" tabindex="0" aria-expanded="${open}">`
      + `<span class="ol-mk" aria-hidden="true">−</span><span class="ol-tt">${r.l ? esc(r.t) : olWords(r.t)}</span>`
      + `<span class="ol-meta">${olDiff(sc, r)}<span class="ol-go-sp"></span>${olTag('removed')}${marks.length ? `<button type="button" class="tick ol-tick${st.open ? '' : ' on'}" data-act="mark-blocks" data-blocks="${esc(marks.map((b) => b.id).join(' '))}" title="${st.open ? 'Mark the removal reviewed' : 'Mark unreviewed'}" aria-pressed="${!st.open}"></button>` : '<span class="ol-tick-sp"></span>'}</span></div>`;
    for (const leaf of r.leaves) {
      const rest = leaf.slice(prefix + r.t.trim().length).trim();
      if (rest) h += `<div class="ol-row del sub" style="--d:${d + 1}"><span class="ol-mk"></span><span class="ol-tt">${olWords(rest)}</span><span class="ol-meta"></span></div>`;
    }
    return h + (open ? olCodeHtml(sc, r) : '');
  }
  // A test as its whole sentence: the groups it takes after dimmed, a group's changed words only on
  // the first test of the run it heads.
  function olSentenceHtml(sc, n, prev, o) {
    const f = sc.f, s = sc.st.get(n) || { s: null, own: [], all: [] };
    const key = olKey(f, n), cls = olStatus(s.s) || (s.s === 'edited' ? 'edit' : 'ctx');
    const groups = olPath(n).slice(0, -1).filter((g) => !g.l).map((g) => {
      const gs = sc.st.get(g) || {};
      const was = g.ot != null && gs.s === 'renamed' && !(prev && prev.includes(g)) ? g.ot : null;
      return `<span class="g${gs.s === 'new' ? ' gnew' : ''}">${olWords(g.t, was)}${olNoSetup(g)}</span>`;
    }).join(' ');
    const was = n.ot != null && s.s === 'reworded' ? n.ot : null;
    // Reworded through a renamed group: the chain that renamed it.
    const by = s.s === 'reworded' && n.ot == null ? olPath(n).slice(0, -1).reverse().find((g) => g.st === 'renamed' && (g.head || []).length) || n : n;
    const writer = o.chips && (s.s === 'new' || s.s === 'reworded') ? olWriter(f, by) : null;
    const marks = s.s ? s.all : [];
    const st = stats(marks), open = state.olOpen.has(key);
    const tick = marks.length && !outOfLens(st) ? `<button type="button" class="tick ol-tick${st.open ? '' : ' on'}" data-act="mark-blocks" data-blocks="${esc(marks.map((b) => b.id).join(' '))}" title="${st.open ? 'Mark this test reviewed' : 'Mark unreviewed'}" aria-pressed="${!st.open}"></button>` : '<span class="ol-tick-sp"></span>';
    const nav = s.own.length ? ` data-mark="${esc(s.own.map((b) => b.id).join(' '))}" data-block="${esc(s.own[0].id)}"${stats(s.own).open ? ' data-nav="1"' : ''}` : '';
    return `<div class="ol-row sent ${cls}${open ? ' open' : ''}${marks.length && !st.open ? ' done' : ''}" data-act="ol-open" data-ol="${esc(key)}"${nav} style="--d:0" role="button" tabindex="0" aria-expanded="${open}">`
      + `<span class="ol-mk" aria-hidden="true">${OL_MARK[cls] || ''}</span><span class="ol-tt">${groups} <span class="own">${olWords(n.t, was)}</span></span>`
      + `<span class="ol-meta">${olExpects(n)}${olDiff(sc, n)}${writer ? olChip(writer, key, o.chips) : ''}<button type="button" class="ol-go" data-open="${esc(f.p)}" data-line="${n.s}" title="Open in the file, at line ${n.s}" aria-label="Open in the file">${ICON.intoFile}</button>${s.s === 'regrouped' ? olTag('regrouped', `It read: ${n.was || ''}`) : ''}${tick}</span></div>`
      + (open ? olCodeHtml(sc, n) : '');
  }
  // Which tests a filter keeps.
  const olKeeps = (sc, n, filter) => filter === 'all' || (n.k === 't' && sc.st.get(n).s === filter);
  // Reviewed, so the Tests view folds it away: everything a row's mark covers (a test, a group with
  // everything under it, a removal), when it covers something.
  function olSettled(sc, n) {
    const marks = n.removed ? olGoneMarks(sc, n) : (sc.st.get(n) || { all: [] }).all;
    const st = stats(marks);
    return st.total > 0 && !st.open;
  }
  const olTestsIn = (sc, n) => (n.removed ? 0 : n.k === 't' ? 1 : n.kids.reduce((x, k) => x + (sc.show.has(k) ? olTestsIn(sc, k) : 0), 0));
  const olReviewedWhat = (tests, gone, folded) => (folded
    ? [tests && plural(tests, 'test'), gone && plural(gone, 'removal')].filter(Boolean).join(' and ') + ' reviewed'
    : 'Fold the ' + [tests && plural(tests, 'reviewed test'), gone && plural(gone, tests ? 'removal' : 'reviewed removal')].filter(Boolean).join(' and '));
  // A run of reviewed rows, folded to one line that shows them again (as a reviewed hunk folds into
  // its divider). It lists the calls it holds, so what's found by one of them finds the line.
  const olRunKey = (sc, run) => 'ok|' + olKey(sc.f, run[0]);
  function olRunHtml(sc, run) {
    const key = olRunKey(sc, run), open = state.olUnfold.has(key);
    const x = run[0], d = x.removed ? (x.parent ? x.parent.depth + 1 : 0) : x.depth;
    const under = (n) => (n.removed ? [olKey(sc.f, n)] : [olKey(sc.f, n), ...n.kids.flatMap(under)]);
    const what = olReviewedWhat(run.reduce((t, n) => t + olTestsIn(sc, n), 0), run.reduce((t, n) => t + (n.removed ? n.leaves.length : 0), 0), !open);
    return `<div class="ol-fold ok${open ? ' open' : ''}" data-act="ol-unfold" data-key="${esc(key)}" data-in="${esc(run.flatMap(under).join(' '))}" style="--d:${d}" role="button" tabindex="0" aria-expanded="${open}">${open ? '' : `<span class="ok-ic" aria-hidden="true">${ICON.check}</span>`}${what}</div>`;
  }
  // A file's outline for a scope. o: { secs: the chain's member numbers it stands for, chips,
  // sentences, filter }.
  function olFileHtml(sc, o = {}) {
    const f = sc.f, filter = o.filter || 'all';
    const c = olCounts(sc);
    if (filter !== 'all' && !(filter === 'removed' ? sc.rm.length : [...sc.show].some((n) => olKeeps(sc, n, filter)))) return '';
    const secs = o.secs && o.secs.length ? ` id="sec-${o.secs[0]}" data-secs="${o.secs.join(' ')}"` : '';
    const dir = f.p.slice(0, f.p.length - fileName(f.p).length);
    let h = `<section class="sec ol-sec"${secs} data-olf="${esc(f.p)}">`;
    if (!sc.any && !sc.chain) {
      // Nothing it asserts changed: one row, which opens on the calls whose code changed.
      const key = f.p + '#edited', open = state.olUnfold.has(key);
      const edits = sc.edited.flatMap((n) => sc.st.get(n).own).concat(sc.outside);
      const marks = olFileMarks(sc), st = stats(marks);
      h += `<div class="ol-file fold${open ? ' open' : ''}${st.total && !st.open ? ' done' : ''}" data-act="ol-unfold" data-key="${esc(key)}" role="button" tabindex="0" aria-expanded="${open}"><span class="car">${open ? ICON.chevronDown : ICON.chevronRight}</span><button type="button" class="nm linkish" data-open="${esc(f.p)}" title="Open the file">${esc(fileName(f.p))}</button><span class="dir">${esc(dir)}</span><span class="sp"></span><span class="n">${sc.edited.length ? `${plural(sc.edited.length, 'call')} edited` : 'outside the tests'} · ${plusMinus(sumOf(edits, 'adds'), sumOf(edits, 'dels'))}</span>${olFileTickHtml(sc, marks, st)}</div>`;
      if (open) h += olEditedRowsHtml(sc, o) + (sc.outside.length ? olOutsideHtml(sc) : '');
      return h + '</section>';
    }
    // In the Tests view, a file reviewed whole folds to this line, as a reviewed hunk does, and its
    // mark reviews it whole; what's reviewed in a file still open folds as it's marked.
    let settle = false;
    if (o.settle) {
      const fkey = 'olf|' + f.p, marks = olFileMarks(sc);
      const st = stats(marks), all = st.total > 0 && !st.open;
      const folded = state.collapsed.has(fkey) || (all && !state.expanded.has(fkey));
      const said = folded && all ? `<span class="ok-ic" aria-hidden="true">${ICON.check}</span>${olReviewedWhat(c.new + c.reworded + c.regrouped, c.removed, true)}` : (olSaid(c) || 'no sentence changes') + (folded && st.open ? ` · ${st.open} to review` : '');
      h += `<div class="ol-file ck${all ? ' done' : ''}"><button type="button" class="car" data-act="ol-file" data-key="${esc(fkey)}" aria-expanded="${!folded}" title="${folded ? 'Unfold' : 'Fold'}">${folded ? ICON.chevronRight : ICON.chevronDown}</button><button type="button" class="nm linkish" data-open="${esc(f.p)}" title="Open the file">${esc(fileName(f.p))}</button><span class="dir">${esc(dir)}</span><span class="sp"></span><span class="n">${said}</span>${olFileTickHtml(sc, marks, st)}</div>`;
      if (folded) return h + '</section>';
      settle = st.open > 0;
    } else {
      const marks = olFileMarks(sc), st = stats(marks);
      h += `<div class="ol-file${st.total && !st.open ? ' done' : ''}"><button type="button" class="nm linkish" data-open="${esc(f.p)}" title="Open the file">${esc(fileName(f.p))}</button><span class="dir">${esc(dir)}</span><span class="sp"></span><span class="n">${olSaid(c) || 'no sentence changes'}</span>${olFileTickHtml(sc, marks, st)}</div>`;
    }
    if (o.sentences) {
      let label = null, prev = null, run = [];
      const sentence = (n) => { h += olSentenceHtml(sc, n, prev, o); prev = olPath(n); };
      const flush = () => {
        if (!run.length) return;
        h += olRunHtml(sc, run);
        if (state.olUnfold.has(olRunKey(sc, run))) run.forEach(sentence);
        run = [];
      };
      for (const n of sc.ol.nodes) {
        if (n.k !== 't' || !sc.show.has(n) || !olKeeps(sc, n, filter)) continue;
        const lbl = olPath(n).find((x) => x.l);
        if (lbl && lbl !== label) { flush(); h += `<div class="ol-lbl">${esc(lbl.t)}</div>`; label = lbl; }
        if (settle && olSettled(sc, n)) { run.push(n); continue; }
        flush();
        sentence(n);
      }
      flush();
    } else {
      // A parent's calls, with its removed ones after them; reviewed ones in a row fold to a line.
      const walk = (list, parent, runs) => {
        let hidden = [];
        const items = [];
        for (const n of list) {
          const unfolded = parent && state.olUnfold.has(olKey(f, parent));
          if (!sc.show.has(n) && !unfolded) { hidden.push(n); continue; }
          if (filter !== 'all' && !sc.ol.nodes.some((x) => sc.show.has(x) && olKeeps(sc, x, filter) && olPath(x).includes(n))) continue;
          items.push(n);
        }
        if (filter === 'all' || filter === 'removed') sc.rm.filter((r) => r.parent === parent).forEach((r) => items.push(r));
        // A run shown again shows all of itself: nothing in it folds.
        const emit = (x, folding) => { if (x.removed) h += olRemovedHtml(sc, x); else { h += olRowHtml(sc, x, o); walk(x.kids, x, folding); } };
        let run = [];
        const flush = () => {
          if (!run.length) return;
          h += olRunHtml(sc, run);
          if (state.olUnfold.has(olRunKey(sc, run))) run.forEach((x) => emit(x, false));
          run = [];
        };
        for (const x of items) {
          if (runs && olSettled(sc, x)) { run.push(x); continue; }
          flush();
          emit(x, runs);
        }
        flush();
        if (parent && filter === 'all' && (hidden.length || state.olUnfold.has(olKey(f, parent))) && parent.kids.some((k) => !sc.show.has(k))) {
          const unfolded = state.olUnfold.has(olKey(f, parent));
          const all = parent.kids.filter((k) => !sc.show.has(k));
          const words = new Set(all.map((k) => (/^\s*given\b/i.test(k.t) ? 'Given' : /^\s*when\b/i.test(k.t) ? 'when' : /^\s*then\b/i.test(k.t) ? 'then' : '')));
          const kind = words.size === 1 && !words.has('') ? [...words][0] : 'call';
          h += `<div class="ol-fold" data-act="ol-unfold" data-key="${esc(olKey(f, parent))}" style="--d:${parent.depth + 1}" role="button" tabindex="0" aria-expanded="${unfolded}">${unfolded ? `Fold the ${plural(all.length, 'unchanged ' + kind)}` : `+ ${plural(all.length, 'unchanged ' + kind)}`}</div>`;
        }
      };
      walk(sc.ol.top, null, settle);
    }
    if (filter === 'all' && sc.edited.length) {
      const key = f.p + '#edited', open = olFold(sc, key);
      const edits = sc.edited.flatMap((n) => sc.st.get(n).own);
      h += `<div class="ol-fold cf" data-act="ol-unfold" data-key="${esc(olFoldKey(sc, key))}" role="button" tabindex="0" aria-expanded="${open}"><span class="car">${open ? ICON.chevronDown : ICON.chevronRight}</span>Code edited under ${plural(sc.edited.length, 'call')} whose sentence${sc.edited.length === 1 ? '' : 's'} stay${sc.edited.length === 1 ? 's' : ''} · ${plusMinus(sumOf(edits, 'adds'), sumOf(edits, 'dels'))}</div>`;
      if (open) h += olEditedRowsHtml(sc, o);
    }
    if (filter === 'all' && sc.outside.length) h += olOutsideHtml(sc);
    return h + '</section>';
  }
  // The calls whose code a scope edited under a sentence that stayed, with the groups above them.
  function olEditedRowsHtml(sc, o) {
    const keep = new Set();
    sc.edited.forEach((n) => { for (let x = n; x; x = x.parent) keep.add(x); });
    const sub = { ...sc, st: new Map([...sc.st].map(([n, s]) => [n, sc.edited.includes(n) ? s : { ...s, s: null }])) };
    let h = '';
    const walk = (list) => list.forEach((n) => { if (!keep.has(n)) return; h += olRowHtml(sub, n, o); walk(n.kids); });
    walk(sc.ol.top);
    return h;
  }
  // Changes outside every call: imports and helpers, as code.
  function olOutsideHtml(sc) {
    const f = sc.f, key = f.p + '#outside', open = olFold(sc, key);
    const names = [...new Set(sc.outside.map((b) => (b.member || '').split('.')[0]).filter((x) => x && x !== 'main'))];
    let h = `<div class="ol-fold cf" data-act="ol-unfold" data-key="${esc(olFoldKey(sc, key))}" role="button" tabindex="0" aria-expanded="${open}"><span class="car">${open ? ICON.chevronDown : ICON.chevronRight}</span>Outside the tests${names.length ? `: <code>${esc(names.slice(0, 3).join(', '))}</code>${names.length > 3 ? ` and ${names.length - 3} more` : ''}` : ''} · ${plusMinus(sumOf(sc.outside, 'adds'), sumOf(sc.outside, 'dels'))}</div>`;
    if (open) h += `<div class="ol-out">${subHunksHtml(sc.outside, { chain: sc.chain || undefined, key: 'olo|' + f.p, tight: true })}</div>`;
    return h;
  }
  // A chain's members that are a test file's changes, read as that file's outline: the files, and
  // the members each one stands for. A same change keeps its places.
  function chainTests(c) {
    const outlined = (f) => !!olOf(f) && TEST_FILE.test(f.p);
    const nodes = new Set(), secs = new Map();
    c.graph.nodes.forEach((n) => {
      if (n.group != null) return;
      const bs = blocksOf(n.blocks);
      if (!bs.length || !bs.every((b) => outlined(b.file))) return;
      nodes.add(n);
      new Set(bs.map((b) => b.file)).forEach((f) => { if (!secs.has(f)) secs.set(f, []); secs.get(f).push(n.idx); });
    });
    return { files: [...secs.keys()].sort((x, y) => x.idx - y.idx), secs, nodes };
  }
  // Why a commit's chain exists: its message. The commits that wrote the chain are in its bar.
  function commitNoteHtml(fam) {
    const f = fam.commit;
    const open = state.noteOpen.has(f.id);
    const paras = (f.body || '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
    const body = paras.length ? `<p class="cm-text">${messageHtml(open ? paras.join('\n\n') : paras[0])}</p>${paras.length > 1 ? `<button type="button" class="linkish" data-act="note-more" data-family="${f.id}">${open ? 'Show less' : 'Show the whole message'}</button>` : ''}` : '';
    return `<div class="cm-note"><p class="cm-subj">${f.kind ? `<span class="tag">${esc(f.kind)}</span> ` : ''}${messageHtml(f.subject)} <code>${shortSha(f.sha)}</code></p>${body}</div>`;
  }
  // The commits of a chain's family: its first and the ones that followed it up (indices into the
  // history).
  const familyCommits = (fam) => (fam && fam.commit && hxOn() ? fam.commit.commits.map((x) => HX.index.get(x.sha)).filter((i) => i != null) : []);
  // Where the chain's own commits also wrote lines: the other chains, with that commit's changes
  // in each, as History's chips count them.
  function alsoIn(c, fam) {
    const m = M(), out = [];
    familyCommits(fam).forEach((ci) => {
      const per = new Map();
      commitParts()[ci].forEach((b) => (m.chainsOf.get(b.id) || []).forEach((id) => { if (id !== c.id) per.set(id, (per.get(id) || 0) + 1); }));
      [...per].sort((x, y) => y[1] - x[1] || x[0] - y[0]).forEach(([id, n]) => out.push({ ci, chain: id, n }));
    });
    return out;
  }
  const shareOf = (n, total) => { const p = (n / total) * 100; return p < 1 ? 'under 1%' : `${Math.round(p)}%`; };
  // By commit, under a chain's members: who last wrote its changed lines, a part of a thin bar for
  // each commit, oldest first, as wide as its share (the chain's own commits lighter; hovering one
  // dims the lines it didn't write; a click makes it the lens). One commit alone needs no bar. Then
  // how many commits (the Commits tab marks them), the other chains its commits wrote in, and its
  // commit's card.
  function writersHtml(c, fam) {
    if (!hxOn()) return '';
    const w = chainWriters(c);
    if (!w.size) return '';
    const own = new Set(familyCommits(fam));
    const order = [...w.keys()].sort((x, y) => y - x);
    const total = order.reduce((n, ci) => n + w.get(ci).lines, 0);
    const segs = order.map((ci) => {
      const x = w.get(ci), cm = HISTORY.commits[ci], share = shareOf(x.lines, total);
      const tip = `${cm.subject}\n${shortSha(cm.sha)} · ${cm.author} · ${whenOf(cm.at)}\n${own.has(ci) ? 'This chain’s commit. ' : ''}It last wrote ${x.lines} of the ${plural(total, 'changed line')} here (${share}), in ${plural(x.changes, 'change')}.\n\nClick for only its lines; Shift-click for a range.`;
      return `<button type="button" class="wb-seg${own.has(ci) ? ' own' : ''}${commitInLens(ci) ? ' in' : ''}" data-act="wb-seg" data-sha="${cm.sha}" data-ci="${ci}" style="flex-grow:${x.lines}" title="${esc(tip)}" aria-label="${esc(`${shortSha(cm.sha)} ${subjectOf(cm).text}: ${share} of the lines`)}"></button>`;
    }).join('');
    const also = new Set(alsoIn(c, fam).map((x) => x.chain)).size;
    const sha = fam && fam.commit ? fam.commit.sha : null;
    const shown = state.tab === 'commits' && !UI.sideOff;
    return `<div class="wb">${order.length > 1 ? `<div class="wb-bar" role="group" aria-label="Who wrote this chain’s lines">${segs}</div>` : ''}`
      + (shown ? `<span class="wb-n" title="The Commits tab marks them">${plural(order.length, 'commit')}</span>` : `<button type="button" class="lnk" data-act="show-commits" title="The commits that wrote this chain’s lines: the Commits tab marks them">${plural(order.length, 'commit')}</button>`)
      + (also ? `<button type="button" class="lnk" data-act="menu" data-menu="also" aria-haspopup="menu" aria-expanded="${MENU.open === 'also'}" title="The other chains this chain’s commit${own.size > 1 ? 's' : ''} wrote lines in">Also in ${plural(also, 'chain')}${ICON.chevronDown}</button>` : '')
      + (sha ? `<button type="button" class="lnk" data-act="card" data-sha="${sha}" aria-expanded="${state.card === sha}" title="${state.card === sha ? 'Hide' : 'Show'} the commit’s details, as History shows them">Commit details</button>` : '')
      + '</div>';
  }
  const graphLegendHtml = (c) => `<div class="graph-legend"><span><i class="lg-open"></i>has changes to review</span><span><i class="lg-ok"></i>reviewed</span><span>Arrows point from a change to what it uses. Click a member to go to its code; Shift-click to show only its code, and what its arrows use.</span>${(c.ext || []).length ? '<span>A dotted box is changed in another chain: click it to see its change.</span>' : ''}</div>`;
  function renderChain(id) {
    const m = M();
    const c = m.chains[id];
    if (!c) return '<div class="empty">This chain doesn’t exist in this comparison.</div>';
    const all = blocksOf(c.blocks);
    const s = stats(all);
    const kind = c.kind === 'declaration' ? 'new implementation' : c.kind === 'group' && !c.rootKind ? (m.byCommit ? 'rename' : 'same change') : c.kind === 'commit' ? 'commit' : kindWord[c.rootKind] || 'chain';
    // By commit: the commit this chain is.
    const fam = m.byCommit ? m.families.find((f) => f.id === c.family) : null;
    // Its test files read as outlines, after its code; a chain of tests alone is only them.
    const tests = chainTests(c);
    const testOnly = tests.files.length > 0 && c.graph.nodes.every((n) => tests.nodes.has(n));
    let h = headerHtml({
      crumbs: `<button type="button" data-map="${c.family}" title="Open the chain map">Map</button>${SEP}<b${proseName(c) ? ' class="ui"' : ''} title="${esc(c.name + ' · ' + kind)}">${esc(c.name)}</b>`,
      facts: `${kind !== 'changed member' ? cap(kind) + ' · ' : ''}${leftWords(s)} · ${c.files} file${c.files > 1 ? 's' : ''} · ${plusMinus(c.adds, c.dels)}`,
      nav: true,
      // The member being read, and the chain's graph: open in the page at the top, and dropped
      // from here anywhere else.
      lead: '<span class="fv-here"></span>',
      tools: iconBtn(ICON.graph, 'The chain’s graph: hover for a look, click to keep it open (g)', 'data-act="graph" aria-haspopup="dialog" aria-expanded="false"', { label: 'Graph', on: true }),
      action: outOfLens(s) ? '' : `<button type="button" class="btn${s.open ? ' primary' : ''}" data-act="mark-chain" data-chain-id="${c.id}">${s.open ? 'Mark chain reviewed' : 'Mark chain unreviewed'}</button>`,
      // By commit, the commits that wrote the chain stay under the header.
      pinned: m.byCommit ? writersHtml(c, fam) : '',
      below: fam && fam.commit ? commitNoteHtml(fam) + (state.card === fam.commit.sha && hxOn() && HX.index.has(state.card) ? detailHtml(HX.index.get(state.card), '') : '') : '',
    });
    h += `<div class="graph-box chain-graph"><div class="graph-scroll">${graphSvg(c)}</div>${graphLegendHtml(c)}</div>`;
    if (testOnly) return h + extNoteHtml(c) + tests.files.map((f) => olFileHtml(olScope(f, c), { secs: tests.secs.get(f) })).join('') + '<div class="chain-end" aria-hidden="true"></div>';
    const focused = state.focus && state.focus.chain === c.id ? c.graph.nodes[state.focus.node] : null;
    if (focused) {
      const { l2 } = nodeLabels(focused);
      const count = stats(blocksOf(focused.blocks)).total;
      h += `<div class="focus-bar">Showing only <b>${esc(l2)}</b> · ${count} change${count > 1 ? 's' : ''}<span class="sp"></span><button type="button" class="btn xs" data-act="clear-focus">Show all ${c.graph.nodes.length} members</button></div>`;
    }
    c.graph.nodes.forEach((n) => {
      if ((focused && n !== focused) || tests.nodes.has(n)) return;
      const blocks = blocksOf(n.blocks);
      const ns = stats(blocks);
      const { l1, l2, owner } = nodeLabels(n);
      const out = c.graph.edges.filter((e) => e.from === n.key), usedByN = c.graph.edges.filter((e) => e.to === n.key).length;
      const usesFull = out.map((e) => `uses ${e.labels.join(', ')} of ${nodeLabels(c.graph.nodes.find((x) => x.key === e.to)).l2}`);
      const rel = (out.length === 1 ? [`uses ${nodeLabels(c.graph.nodes.find((x) => x.key === out[0].to)).l2}`] : out.length ? [`uses ${out.length}`] : []).concat(usedByN ? [`used by ${usedByN}`] : []).join(' · ');
      const full = usesFull.concat(usedByN ? [`used by ${usedByN} member${usedByN > 1 ? 's' : ''}`] : []).join('; ');
      h += `<section class="sec${lensOn() && !blocks.some((b) => b.edits.length && blockIn(b)) ? ' lens-out' : ''}" id="sec-${n.idx}"><div class="sec-h"><b>${esc(l2)}</b><span>${esc(owner ? owner + ' · ' + l1 : l1)}</span>${n.key === c.graph.root ? '<span class="tag">root</span>' : ''}${rel ? `<span title="${esc(full)}">${esc(rel)}</span>` : ''}<span class="sp"></span>`
        + `<span class="hov"><span>${leftWords(ns)} · ${plusMinus(sumOf(blocks, 'adds'), sumOf(blocks, 'dels'))}</span>${outOfLens(ns) ? '' : `<button type="button" class="btn xs" data-act="mark-blocks" data-blocks="${esc(n.blocks.join(' '))}">${ns.open ? 'Mark reviewed' : 'Mark unreviewed'}</button>`}</span></div>`
        + extNoteHtml(c, n);
      if (n.group !== null && n.group !== undefined) {
        const g = m.groupById.get(n.group);
        h += `<p class="sec-note">The same change in ${blocks.length} places. Each place shows the whole edit.</p>` + instancesHtml(g, blocks, 'chain' + c.id + ':' + n.idx);
      } else {
        h += subHunksHtml(blocks, { chain: c, unit: n.unit, whole: blocks.every((b) => b.unit), key: 'c' + c.id + 'n' + n.idx });
        // The member's other changes belong to other chains: folded context here.
        const rest = n.member ? [...new Set(blocks.map((b) => b.mk))].flatMap((k) => m.byMember.get(k) || []).filter((b) => !c.blockSet.has(b.id)) : [];
        if (rest.length) {
          const key = c.id + ':' + n.idx, open = state.memberOpen.has(key);
          const others = [...new Set(rest.flatMap((b) => m.chainsOf.get(b.id) || []))];
          h += `<div class="more-row ctx-row"><button type="button" class="linkish" data-act="toggle-member" data-key="${esc(key)}">${open ? 'Hide' : 'Show'} ${rest.length} more change${rest.length > 1 ? 's' : ''} in this member</button><span>, in ${others.length ? others.slice(0, 2).map((o) => esc(m.chains[o].name)).join(', ') + (others.length > 2 ? ` +${others.length - 2}` : '') : 'no chain'}</span></div>`;
          if (open) h += subHunksHtml(rest, { chain: c, key: 'cm' + key });
        }
      }
      h += '</section>';
    });
    const testFiles = focused ? tests.files.filter((f) => tests.secs.get(f).includes(focused.idx)) : tests.files;
    if (testFiles.length) h += `<div class="ol-sect">Tests${testFiles.length > 1 ? ` · ${testFiles.length} files` : ''}</div>` + testFiles.map((f) => olFileHtml(olScope(f, c), { secs: tests.secs.get(f) })).join('');
    return h + '<div class="chain-end" aria-hidden="true"></div>';
  }
  // ---------- pinned groups: over a test file's code or outline, the groups of the line at the top
  // of the view whose own lines have scrolled away above it, so a test read in the middle of its
  // file keeps its sentence on screen.
  function olPin() {
    const pin = main.querySelector('.ol-pin');
    if (!pin) return;
    const hh = headH();
    main.style.setProperty('--hh', hh + 'px');
    // The line right under the header, which the pin covers: what it pins doesn't move what it reads.
    const box = main.getBoundingClientRect();
    const top = box.top + hh;
    const m = M();
    const byPath = m.byPath || (m.byPath = new Map(m.files.map((f) => [f.p, f])));
    // Only a test's outline or code has groups to pin, so the line is looked for only under one of
    // them: among the rows in their order, the first whose bottom is below the line, if it's on it.
    const tests = paneQuery('tests', () => [...main.querySelectorAll('.ol-sec[data-olf], .code[data-p]')].filter((el) => el.matches('.ol-sec') || olOf(byPath.get(el.dataset.p))));
    const under = tests.some((el) => { const r = el.getBoundingClientRect(); return r.top <= top + 3 && r.bottom > top + 3; });
    let row = null;
    if (under) {
      const rows = paneQuery('rows', () => [...main.querySelectorAll('.ol-row[data-ol], .code > .ln, .code > .sl')]);
      const r = rows[firstWhere(rows, (x) => x.getBoundingClientRect().bottom > top + 3)];
      if (r && r.getBoundingClientRect().top <= top + 3) row = r;
    }
    // Above the top: every element that stands for the call (its outline row, its call's line).
    const gone = (f, g) => {
      const els = paneQuery('call ' + olKey(f, g), () => [...main.querySelectorAll('.ol-row[data-ol]')].filter((x) => x.dataset.ol === olKey(f, g))
        .concat([...main.querySelectorAll('.code[data-p]')].filter((c) => c.dataset.p === f.p).flatMap((c) => [...c.querySelectorAll(`[data-n="${g.s}"]`)])));
      return els.every((x) => x.getBoundingClientRect().bottom <= top + 1);
    };
    let groups = [], f = null;
    if (row && row.matches('.ol-row')) {
      if (!row.matches('.sent')) {
        const at = row.dataset.ol.lastIndexOf('#'), id = row.dataset.ol.slice(at + 1);
        f = byPath.get(row.dataset.ol.slice(0, at));
        const ol = olOf(f), n = ol && (id[0] === 'r' ? ol.removed[Number(id.slice(1))] : ol.nodes[Number(id)]);
        if (n && n.parent) groups = olPath(n.parent).filter((g) => gone(f, g));
      }
    } else if (row) {
      const code = row.closest('.code[data-p]');
      f = code && byPath.get(code.dataset.p);
      let r = row;
      while (r && !r.dataset.n) r = prevIn(r);
      const ln = r ? Number(r.dataset.n) : 0, ol = olOf(f);
      if (ol && ln) groups = ol.nodes.filter((n) => n.s < ln && ln <= n.e).filter((g) => gone(f, g));
    }
    const h = groups.map((g, i) => `<div class="ol-pin-l${g.l ? ' lbl' : ''}" style="--d:${i}">${g.l ? esc(g.t) : olWords(g.t)}</div>`).join('');
    if (pin.innerHTML !== h) pin.innerHTML = h;
    pin.classList.toggle('on', !!h);
  }

  // ---------- the chain's graph, from the header. At the top of a chain it's open under the header,
  // in the page, and as the code scrolls it under the header it shrinks into the header's graph
  // button. Anywhere else in the chain, or in a file whose changes are in chains, hovering the button
  // drops the graph over the code (a look) and clicking keeps it there, centered on the member being
  // read. It drops and folds back with one motion, played forward and back.
  const GD = { enterT: 0, leaveT: 0, folded: null, view: null, anim: null, order: [] };
  const GD_FRAMES = [
    { opacity: 0, transform: 'translateY(-8px)', clipPath: 'inset(0 0 100% 0 round 0 0 12px 12px)' },
    { opacity: 1, transform: 'none', clipPath: 'inset(0 0 0 0 round 0 0 12px 12px)' },
  ];
  const GD_MS = 220;
  // A test's outline row stands for the member whose blocks hold its own lines.
  const rowNode = (c, row) => { const ids = new Set(row.dataset.mark.split(' ')); return c.graph.nodes.findIndex((n) => n.blocks.some((b) => ids.has(b))); };
  // The members in the order the page shows them (those it doesn't show, after).
  function gdOrder(c) {
    const out = [];
    main.querySelectorAll('.sec[id^="sec-"]:not(.ol-sec), .ol-row[data-mark]').forEach((el) => {
      if (el.closest('.gd')) return;
      const i = el.matches('.ol-row') ? rowNode(c, el) : Number(el.id.slice(4));
      if (i >= 0 && !out.includes(i)) out.push(i);
    });
    c.graph.nodes.forEach((n) => { if (!out.includes(n.idx)) out.push(n.idx); });
    return out;
  }
  // The member being read: the last one whose code (its section, or a test's row) starts above the
  // reading line.
  function hereNode(c) {
    const ref = readY();
    let at = null;
    for (const el of paneQuery('members', () => [...main.querySelectorAll('.sec[id^="sec-"], .ol-row[data-mark]')].filter((x) => !x.closest('.gd')))) {
      if (el.getBoundingClientRect().top > ref) break;
      at = el;
    }
    if (!at) return GD.order.length ? GD.order[0] : null;
    if (at.matches('.ol-row')) { const i = rowNode(c, at); if (i >= 0) return i; }
    return at.dataset.secs ? Number(at.dataset.secs.split(' ')[0]) : Number(at.id.slice(4));
  }
  // The header names the member being read, and its place in the chain.
  function spyHere() {
    const el = main.querySelector('.fv-head .fv-here');
    if (!el || state.view.kind !== 'chain') return;
    const c = M().chains[state.view.id], i = c ? hereNode(c) : null, n = i != null && c.graph.nodes[i];
    const h = n ? `Reading <b>${esc(nodeLabels(n).l2)}</b> · ${GD.order.indexOf(i) + 1} of ${c.graph.nodes.length}` : '';
    if (el.innerHTML !== h) { el.innerHTML = h; renderWhere(); }
  }
  // As the code scrolls the graph under the header, its last stretch shrinks toward the graph's
  // button, which takes it once it's gone (a pulse). Scrolling back up plays it back.
  function foldGraph() {
    const box = main.querySelector('.graph-box.chain-graph'), btn = main.querySelector('.fv-head [data-act="graph"]');
    if (!box || !btn) return;
    const r = box.getBoundingClientRect(), top = main.getBoundingClientRect().top + headH();
    const k = r.height ? Math.max(0, Math.min(1, (top - r.top) / r.height)) : 1, late = Math.max(0, (k - 0.55) / 0.45);
    if (moving()) {
      const b = btn.getBoundingClientRect();
      box.style.transformOrigin = `${Math.round(b.left + b.width / 2 - r.left)}px 0`;
      box.style.transform = late ? `scale(${1 - late * 0.06})` : '';
      box.style.opacity = late ? String(1 - late * 0.85) : '';
    }
    const folded = r.bottom <= top + 4;
    btn.setAttribute('aria-pressed', String(!folded));
    if (folded && GD.folded === false && moving()) { btn.classList.remove('took'); void btn.offsetWidth; btn.classList.add('took'); }
    GD.folded = folded;
  }
  // A chain shorter than the pane gets room after its end, so scrolling can still fold its graph.
  function roomToFold() {
    const end = main.querySelector('.chain-end'), box = main.querySelector('.graph-box.chain-graph');
    if (!end || !box) return;
    end.style.height = '0px';
    const bottom = box.getBoundingClientRect().bottom - main.getBoundingClientRect().top + main.scrollTop;
    end.style.height = Math.max(0, Math.ceil(bottom - headH() - (main.scrollHeight - main.clientHeight))) + 'px';
  }
  // Whether the graph is (still partly) in the page, under the header.
  const gdInPage = () => { const box = main.querySelector('.graph-box.chain-graph'); return !!box && box.getBoundingClientRect().bottom > main.getBoundingClientRect().top + headH() + 4; };
  function gdFoldNow() {
    const box = main.querySelector('.graph-box.chain-graph');
    if (box) main.scrollTo({ top: main.scrollTop + Math.ceil(box.getBoundingClientRect().bottom - (main.getBoundingClientRect().top + headH())), behavior: moving() ? 'smooth' : 'auto' });
  }
  // A file's chains, when its changes are in any.
  function gdFileChains() {
    const m = M(), f = state.view.kind === 'file' && m.files.find((x) => x.p === state.view.path);
    if (!f) return null;
    const ids = [...new Set(f.blocks.flatMap((b) => m.chainsOf.get(b.id) || []))];
    return ids.length ? { f, ids } : null;
  }
  const gdHas = () => (state.view.kind === 'chain' ? !!M().chains[state.view.id] : !!gdFileChains());
  // The change at a file's reading line, or the nearest one to it.
  function gdBlockAt(f) {
    const ref = readY();
    let line = null;
    for (const r of main.querySelectorAll('.code[data-p] [data-n]')) {
      if (!r.dataset.n || r.closest('.gd')) continue;
      if (r.getBoundingClientRect().top > ref) { if (line == null) line = Number(r.dataset.n); break; }
      line = Number(r.dataset.n);
    }
    if (line == null) return null;
    let best = null, gap = Infinity;
    f.blocks.forEach((b) => {
      const ns = hunkMeta(f.hunks[b.hunk]).slice(b.first, b.first + b.len).map((r) => r.n).filter((x) => x != null);
      if (!ns.length || !b.edits.length) return;
      const g = line < ns[0] ? ns[0] - line : line > ns[ns.length - 1] ? line - ns[ns.length - 1] : 0;
      if (g < gap) { gap = g; best = b; }
    });
    return best;
  }
  // What the dropped graph shows: the chain, the member it's centered on, and (for a file in
  // several chains) the others to pick from.
  function gdTarget() {
    const m = M(), v = state.view;
    if (v.kind === 'chain') { const c = m.chains[v.id]; return c ? { chains: [c], chain: c, here: hereNode(c) } : null; }
    const fc = gdFileChains();
    if (!fc) return null;
    const b = gdBlockAt(fc.f), own = b ? m.chainsOf.get(b.id) || [] : [];
    const pick = state.gdrop && fc.ids.includes(state.gdrop.chain) ? state.gdrop.chain : own.find((id) => fc.ids.includes(id)) ?? fc.ids[0];
    const c = m.chains[pick], here = b ? c.graph.nodes.findIndex((n) => n.blocks.includes(b.id)) : -1;
    return { chains: fc.ids.map((id) => m.chains[id]), chain: c, here: here >= 0 ? here : null };
  }
  function gdHtml(t) {
    const tabs = t.chains.length > 1 ? `<div class="gd-tabs" role="tablist" aria-label="The file’s chains">${t.chains.map((c) => `<button type="button" role="tab" data-act="gd-chain" data-chain-id="${c.id}" aria-selected="${c === t.chain}" title="${esc(c.name)}">${esc(trunc(c.name, 48))}</button>`).join('')}</div>` : '';
    const n = t.here != null ? t.chain.graph.nodes[t.here] : null;
    const at = n ? `<span>Centered on <b>${esc(nodeLabels(n).l2)}</b>, the member you’re reading</span>` : `<span><b>${esc(t.chain.name)}</b></span>`;
    return `${tabs}<div class="gd-scroll">${graphSvg(t.chain, 'd')}</div><div class="gd-foot">${at}<span class="sp"></span><span>${state.view.kind === 'chain' ? 'Click a member to go to it' : 'Click a member to open the chain there'} · <kbd>Esc</kbd> or scrolling folds it</span></div>`;
  }
  // The member being read, ringed and in the middle (in a "+N more" group, the group).
  function gdCenter(el, t, at) {
    const sc = el.querySelector('.gd-scroll');
    if (!sc) return;
    let g = t.here != null ? sc.querySelector(`g.g-node[data-node="${t.here}"]`) : null;
    if (!g && t.here != null) g = sc.querySelector(`.g-more[data-graph-open="c${t.chain.id}:${t.chain.graph.nodes[t.here].layer}"]`);
    if (g) g.classList.add('here');
    if (at) { sc.scrollLeft = at.x; sc.scrollTop = at.y; return; }
    const r = g && g.querySelector('rect');
    if (!r) return;
    sc.scrollLeft = +r.getAttribute('x') + +r.getAttribute('width') / 2 - sc.clientWidth / 2;
    sc.scrollTop = +r.getAttribute('y') + +r.getAttribute('height') / 2 - sc.clientHeight / 2;
  }
  const gdBtn = (open) => { const b = main.querySelector('.fv-head [data-act="graph"]'); if (b) b.setAttribute('aria-expanded', String(open)); };
  // One motion both ways: the drop plays forward, the fold plays the same animation back from
  // wherever it is.
  function gdPlay(el, dir) {
    if (!moving()) { if (GD.anim) GD.anim.cancel(); GD.anim = null; el.hidden = dir < 0; return; }
    let a = GD.anim;
    if (!a || a.effect.target !== el) {
      a = GD.anim = el.animate(GD_FRAMES, { duration: GD_MS, easing: EASE, fill: 'both' });
      // Drawn open (a render while it was down), it folds from its end.
      if (dir < 0) a.finish();
    }
    a.onfinish = () => { if (GD.anim === a && a.playbackRate < 0) { el.hidden = true; a.cancel(); GD.anim = null; } };
    a.playbackRate = dir;
    a.play();
  }
  function gdOpen(kept) {
    const el = main.querySelector('.gd');
    if (!el) return;
    if (gdInPage()) { if (kept) gdFoldNow(); return; }
    const t = gdTarget();
    if (!t) return;
    const was = state.gdrop;
    state.gdrop = { view: viewKey(), kept: !!kept || !!(was && was.kept), chain: t.chain.id };
    // Folding back already: it comes down again from there, as it was.
    const folding = !was && GD.anim && GD.anim.effect.target === el && !el.hidden;
    if (!was && !folding) { el.innerHTML = gdHtml(t); el.hidden = false; gdCenter(el, t); }
    gdBtn(true);
    gdPlay(el, 1);
  }
  function gdClose() {
    clearTimeout(GD.enterT); clearTimeout(GD.leaveT); GD.enterT = 0;
    if (!state.gdrop) return;
    state.gdrop = null;
    gdBtn(false);
    const el = main.querySelector('.gd');
    if (el && !el.hidden) gdPlay(el, -1);
  }
  // Drawn again while it was down: down still, where it was, without moving.
  function gdRestore(at) {
    const el = main.querySelector('.gd'), t = el && gdTarget();
    if (!t) { state.gdrop = null; return; }
    GD.anim = null;
    el.innerHTML = gdHtml(t);
    el.hidden = false;
    gdCenter(el, t, at);
    gdBtn(true);
  }
  // The button's hover drops it after a moment, and leaving the button and the graph lifts it
  // (unless a click kept it).
  const gdSpot = (x) => x instanceof Element && !!x.closest('.fv-head [data-act="graph"], .gd');
  main.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch' || !gdSpot(e.target)) return;
    clearTimeout(GD.leaveT);
    if (!state.gdrop && !GD.enterT && e.target.closest('[data-act="graph"]')) GD.enterT = setTimeout(() => { GD.enterT = 0; gdOpen(false); }, 110);
  });
  main.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'touch' || !gdSpot(e.target) || gdSpot(e.relatedTarget)) return;
    clearTimeout(GD.enterT); GD.enterT = 0;
    if (state.gdrop && !state.gdrop.kept) GD.leaveT = setTimeout(() => { if (state.gdrop && !state.gdrop.kept) gdClose(); }, 260);
  });
  // A member, from the graph: its code, and a pulse there.
  function goNode(i) {
    const c = M().chains[state.view.id], n = c && c.graph.nodes[i];
    if (!n) return;
    if (state.focus && state.focus.chain === c.id) { state.focus = { chain: c.id, node: i }; return render({ section: i }); }
    const ids = new Set(n.blocks);
    const el = main.querySelector(`#sec-${i}:not(.ol-sec)`) || [...main.querySelectorAll('.ol-row[data-mark]')].find((r) => r.dataset.mark.split(' ').some((x) => ids.has(x)))
      || [...main.querySelectorAll('[data-secs]')].find((x) => x.dataset.secs.split(' ').includes(String(i)));
    if (!el) return;
    const cls = el.matches('.ol-row') ? 'flash' : 'flash-sec';
    glideTo(el, headH() + 8, 0, () => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); });
  }

  // ---------- the Tests view: every sentence the review's tests add, reword, regroup or remove, file
  // by file, each with the chain that wrote it, then the code edited under sentences that stay.
  function testsTotals() {
    const m = M();
    if (m.testsTotals) return m.testsTotals;
    const t = { new: 0, reworded: 0, regrouped: 0, removed: 0, files: 0, outlined: 0 };
    m.files.forEach((f) => {
      if (!olOf(f)) return;
      t.outlined++;
      const c = olCounts(olScope(f, null));
      ['new', 'reworded', 'regrouped', 'removed'].forEach((k) => { t[k] += c[k]; });
      if (c.new + c.reworded + c.regrouped + c.removed) t.files++;
    });
    t.all = t.new + t.reworded + t.regrouped + t.removed;
    return (m.testsTotals = t);
  }
  function renderTests() {
    const m = M();
    const scopes = m.files.filter((f) => olOf(f)).map((f) => olScope(f, null));
    const said = scopes.filter((sc) => sc.any), code = scopes.filter((sc) => !sc.any && (sc.edited.length || sc.outside.length));
    const t = testsTotals();
    const filter = state.testsFilter, mode = UI.testsMode === 'sentences' ? 'sentences' : 'nested';
    const b = (act, key, cur, label, title, n) => `<button type="button" data-act="${act}" data-v="${key}" aria-pressed="${cur === key}" title="${esc(title)}"${n === 0 && cur !== key ? ' disabled' : ''}>${label}${n != null ? `<span class="dt" aria-hidden="true">·</span><i>${n}</i>` : ''}</button>`;
    let h = headerHtml({
      crumbs: '<b class="ui">Tests</b>',
      facts: t.all ? `${olSaid(t)} · ${plural(t.files, 'file')}` : 'No sentence changes',
      nav: true,
      pinned: `<div class="ol-bar"><span class="mini-seg" role="group" aria-label="Which sentences">${b('tests-filter', 'all', filter, 'All', 'Every sentence the tests add, reword, regroup or remove', t.all)}${b('tests-filter', 'new', filter, 'New', 'The new sentences', t.new)}${b('tests-filter', 'reworded', filter, 'Reworded', 'The sentences whose words changed', t.reworded)}${b('tests-filter', 'regrouped', filter, 'Regrouped', 'The same sentences, in new groups', t.regrouped)}${b('tests-filter', 'removed', filter, 'Removed', 'The sentences that are gone', t.removed)}</span><span class="sp"></span><span class="mini-seg" role="group" aria-label="Read as">${b('tests-mode', 'nested', mode, 'Nested', 'Each title once, nested as the groups nest')}${b('tests-mode', 'sentences', mode, 'Sentences', 'Each test as its whole sentence')}</span></div>`,
    });
    if (!scopes.length) return h + '<div class="empty">No test file changed in this comparison.</div>';
    const body = said.map((sc) => olFileHtml(sc, { chips: true, sentences: mode === 'sentences', filter, settle: true })).join('');
    h += body || `<div class="empty">No ${filter === 'all' ? 'sentence changes' : filter + ' sentences'} in this comparison.</div>`;
    if (filter === 'all' && code.length) {
      // Folded under the sentences; open when it's all there is (a click folds it).
      const key = said.length ? 'tests:code' : 'tests:code:shut', open = said.length ? state.olUnfold.has(key) : !state.olUnfold.has(key);
      const calls = code.reduce((x, sc) => x + sc.edited.length, 0);
      h += `<div class="ol-sect">Code under sentences that stay</div><div class="ol-fold cf" data-act="ol-unfold" data-key="${key}" role="button" tabindex="0" aria-expanded="${open}"><span class="car">${open ? ICON.chevronDown : ICON.chevronRight}</span>${plural(code.length, 'file')} change${code.length === 1 ? 's' : ''} no sentence${calls ? `: ${plural(calls, 'call')} with edited setup or bodies` : ''}</div>`;
      if (open) h += code.map((sc) => olFileHtml(sc, {})).join('');
    }
    return h;
  }
  function renderMap(famId) {
    const m = M();
    if (m.byCommit) return renderCommitMap();
    const fam = m.families.find((f) => f.id === famId) || m.families[0];
    const linked = m.families.filter((f) => f.chains.length > 1);
    const nx = nextUnreviewed();
    if (!fam) return headerHtml({ crumbs: '<b class="ui">Chain map</b>', facts: 'No chains in this review', action: nx ? '<button type="button" class="btn primary" data-act="next-open">Next to review</button>' : '' }) + '<div class="empty">Review these changes in the Files tab or “Not in a chain”. New declarations stay whole.</div>';
    let h = headerHtml({
      crumbs: '<b class="ui">Chain map</b>',
      facts: `${fam.chains.length} linked chain${fam.chains.length === 1 ? '' : 's'} · ${fam.depth + 1} level${fam.depth ? 's' : ''}`,
      action: nx ? '<button type="button" class="btn primary" data-act="next-open" title="The next chain with changes to review (n)">Next chain to review</button>' : '<span class="facts">All reviewed</span>',
      below: (linked.length > 1 ? `<div class="strip" role="group" aria-label="Families of linked chains">${linked.map((f) => `<button type="button" class="node${f === fam ? ' root' : ''}" data-map="${f.id}"${f === fam ? ' aria-current="true"' : ''}><span class="nm">${esc(f.top.name)}</span><span class="c">${f.chains.length}</span></button>`).join('')}</div>` : '')
        + '<p class="fv-note">A chain uses another when its root member uses that chain’s function, method, field or type. Chains that nothing uses sit on the left; a dashed line joins chains that share changes.</p>',
    });
    h += `<div class="graph-box"><div class="graph-scroll tall">${mapSvg(fam)}</div>
      <div class="graph-legend"><span><i class="lg-open"></i>has changes to review</span><span><i class="lg-ok"></i>reviewed</span><span>Faint arrows skip levels.</span><span><i class="lg-share"></i>shares changes</span><span>Click a chain to open it.</span></div></div>`;
    return h;
  }
  // By commit: each commit's chain after the chains it builds on or whose lines it changes, an
  // arrow from each of them. Renames are listed apart.
  function commitMapSvg(fams) {
    const chainOf = new Map(fams.map((f) => [f.id, f.chains[0]]));
    const after = new Map(fams.map((f) => [f.id, [...new Set([f.commit.buildsOn, ...f.commit.revises])].filter((x) => x != null && chainOf.has(x))]));
    const level = new Map();
    fams.forEach((f) => level.set(f.id, Math.max(-1, ...after.get(f.id).map((x) => level.get(x))) + 1));
    // Only direct links: one already implied by a longer path is left out.
    const next = new Map(fams.map((f) => [f.id, []]));
    fams.forEach((f) => after.get(f.id).forEach((x) => next.get(x).push(f.id)));
    const implied = (x, to) => {
      const seen = new Set(), stack = next.get(x).filter((y) => y !== to);
      while (stack.length) { const y = stack.pop(); if (y === to) return true; if (!seen.has(y)) { seen.add(y); stack.push(...next.get(y)); } }
      return false;
    };
    const edges = [];
    fams.forEach((f) => after.get(f.id).forEach((x) => { if (!implied(x, f.id)) edges.push({ from: 'k' + chainOf.get(x).id, to: 'k' + chainOf.get(f.id).id, labels: [] }); }));
    return layeredSvg({
      id: 'commits', w: 280, cap: 9, faintLong: true, label: `Map of ${fams.length} commits’ chains; arrows point from a chain to the chains that build on it or change its lines.`,
      edges,
      nodes: fams.map((f) => {
        const c = chainOf.get(f.id), s = stats(blocksOf(c.blocks));
        return { key: 'k' + c.id, layer: level.get(f.id), l1: f.commit.kind || 'commit', l2: f.commit.subject, ui: true, cnt: outOfLens(s) ? '' : s.open ? s.open + '/' + s.total : '✓ ' + s.total, out: outOfLens(s), ok: !s.open,
          attr: `data-chain="${c.id}"`, tip: f.commit.subject };
      }),
    });
  }
  function renderCommitMap() {
    const m = M();
    const fams = m.families.filter((f) => f.commit);
    const nx = nextUnreviewed();
    const h = headerHtml({
      crumbs: '<b class="ui">Chain map</b>',
      facts: fams.length ? plural(fams.length, 'commit') : 'No commit has a chain of its own',
      action: nx ? '<button type="button" class="btn primary" data-act="next-open" title="The next chain with changes to review (n)">Next chain to review</button>' : '<span class="facts">All reviewed</span>',
      below: '<p class="fv-note">Each commit’s changes are one chain, with the commits that followed it up. A chain comes after the chains it builds on or whose lines it changes; renames are listed apart.</p>',
    });
    if (!fams.length) return h + '<div class="empty">Every change here is a rename: they are listed apart, in the sidebar.</div>';
    return h + `<div class="graph-box"><div class="graph-scroll tall">${commitMapSvg(fams)}</div>
      <div class="graph-legend"><span><i class="lg-open"></i>has changes to review</span><span><i class="lg-ok"></i>reviewed</span><span>Faint arrows skip levels.</span><span>Click a chain to open it.</span></div></div>`;
  }
  function renderStandalone() {
    const m = M();
    const s = stats(m.standalone);
    const h = headerHtml({
      crumbs: `<button type="button" data-map="" title="Open the chain map">Map</button>${SEP}<b class="ui">Not in a chain</b>`,
      facts: `${leftWords(s)} · ${plusMinus(sumOf(m.standalone, 'adds'), sumOf(m.standalone, 'dels'))}`,
      nav: true,
      action: outOfLens(s) ? '' : `<button type="button" class="btn${s.open ? ' primary' : ''}" data-act="mark-standalone">${s.open ? 'Mark all reviewed' : 'Mark all unreviewed'}</button>`,
      below: '<p class="fv-note">Changes outside a review chain, grouped by file. New declarations stay whole; shared dependencies remain available here.</p>',
    });
    return h + '<div class="sec">' + subHunksHtml(m.standalone, { key: 'standalone' }) + '</div>';
  }
  // A changed file's toggle, in its header: its changes, or the whole of it.
  const wholeBtn = (f) => (CONFIG.served && f.s === 'M' && f.hunks && f.hunks.length ? iconBtn(ICON.wholeFile, state.whole.has(f.p) ? 'Show only the changes' : 'Show the whole file', `data-act="whole" data-p="${esc(f.p)}"`, { label: 'Show the whole file', on: state.whole.has(f.p) }) : '');
  function renderFile(path) {
    const m = M();
    const f = m.files.find((x) => x.p === path);
    if (!f) {
      const g = m.generated.find((x) => x.p === path);
      return g ? renderGenerated(path) : `<div class="empty">${esc(path)} has no changes in this comparison.</div>`;
    }
    const s = stats(f.blocks);
    const chains = [...new Set(f.blocks.flatMap((b) => m.chainsOf.get(b.id) || []))];
    let h = headerHtml({
      crumbs: fileCrumbs(f.p),
      facts: `${f.s === 'A' ? 'Added · ' : f.s === 'D' ? 'Deleted · ' : ''}${leftWords(s)} · ${plusMinus(sumOf(f.blocks, 'adds'), sumOf(f.blocks, 'dels'))}${openThreadsHtml(f.p)}`,
      tools: wholeBtn(f) + (chains.length ? iconBtn(ICON.graph, `The graph of ${chains.length > 1 ? 'the chains of ' : ''}the change you’re reading: hover for a look, click to keep it open (g)`, 'data-act="graph" aria-haspopup="dialog" aria-expanded="false"') : ''),
      chip: chains.length ? `<button type="button" class="chip" data-act="menu" data-menu="chains" aria-haspopup="menu" aria-expanded="${MENU.open === 'chains'}" title="The chains this file's changes are in">In ${chains.length} chain${chains.length > 1 ? 's' : ''}${ICON.chevronDown}</button>` : '',
      nav: true,
      action: s.total ? `<button type="button" class="btn${s.open ? ' primary' : ''}" data-act="mark-file" data-file="${f.idx}">${s.open ? 'Mark file reviewed' : 'Mark file unreviewed'}</button>` : '',
      below: state.compare === 'since' ? `<p class="fv-note warm">Left: your reviewed snapshot (as if you had reviewed everything up to <code>${esc(m.raw.left)}</code>). Right: the head <code>${esc(m.raw.right)}</code>.</p>` : '',
    });
    const ctx = { key: 'file' };
    // Loaded ahead, so the whole file shows at once.
    if (CONFIG.served && f.s === 'M') loadSource({ side: 'head', path: f.p });
    h += fileThreadsHtml(f) + `<div class="code" data-p="${esc(f.p)}">` + (CONFIG.served && state.whole.has(f.p) ? wholeHtml(f, ctx) : sectionsHtml(f, f.hunks.map((hk, hi) => sectionOf(f, hi, 0, hk.rows.length, ctx)), ctx));
    return h + '</div>';
  }
  // A generated file's rows: for reference, without definitions.
  function genRowsHtml(f, hi, s, e) {
    const hk = f.hunks[hi], meta = hunkMeta(hk);
    let h = '';
    for (let i = s; i < e; i++) h += uRow(f, meta[i], hk.rows[i][1], null, { cls: (meta[i].t === '+' ? 'add' : meta[i].t === '-' ? 'del' : 'ctx') + ' gen', refs: false, colors: rowColors(hk.rows, f.p, i), c: true });
    return h;
  }
  function renderGenerated(path) {
    const f = M().generated.find((x) => x.p === path);
    f.lang = f.lang || C.langOf(f.p);
    let h = headerHtml({
      crumbs: fileCrumbs(f.p),
      facts: `Generated (${esc(f.gen)}) · ${plusMinus(f.a, f.d)}${openThreadsHtml(f.p)}`,
      tools: wholeBtn(f),
      below: '<p class="fv-note">Generated: not reviewed and not counted. Shown for reference only.</p>',
    });
    if (!f.hunks) {
      if (!CONFIG.served) return h + `<div class="empty">This file’s ${fmt(f.a + f.d)} changed lines aren’t in this page.</div>`;
      if (f.loadError) return h + `<div class="empty">${esc(f.loadError)}</div>`;
      if (!f.loading) {
        f.loading = true;
        api('generated?p=' + encodeURIComponent(f.p))
          .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.status); return j; }))
          .then((j) => { f.hunks = j.hunks; })
          .catch((e) => { f.loadError = `Couldn’t load this file’s diff: ${e.message}`; })
          .then(() => { if (state.view.kind === 'file' && state.view.path === f.p) render(); });
      }
      return h + `<div class="empty">Loading ${fmt(f.a + f.d)} changed lines…</div>`;
    }
    const ctx = { key: 'gen', rows: genRowsHtml, noRefs: true, unified: true };
    h += fileThreadsHtml(f) + `<div class="code" data-p="${esc(f.p)}">` + (CONFIG.served && state.whole.has(f.p) ? wholeHtml(f, ctx) : sectionsHtml(f, f.hunks.map((hk, hi) => sectionOf(f, hi, 0, hk.rows.length, ctx)), ctx));
    return h + '</div>';
  }
  function renderGroup(id) {
    const g = M().groupById.get(Number(id));
    if (!g) return '<div class="empty">No such group in this comparison.</div>';
    const ok = g.edits.every((x) => rev().has(x));
    const e0 = M().edits[g.parts[0]];
    // Places grouped by the declaration they resolve to, when there is more than one.
    const bySym = new Map();
    g.edits.forEach((id) => { const e = M().edits[id]; const k = e.sym ? e.sym[0] : ''; if (!bySym.has(k)) bySym.set(k, { label: e.sym ? e.sym[1] : '', edits: [] }); bySym.get(k).edits.push(id); });
    const syms = bySym.size > 1 ? [...bySym.values()] : null;
    const left = g.edits.filter((x) => !rev().has(x)).length;
    let h = headerHtml({
      crumbs: `<span>Same change</span>${SEP}<b title="${esc(groupLabel(g))}">${esc(groupLabel(g))}</b>`,
      facts: `${left ? (left === g.edits.length ? `${g.count} places` : `${left} of ${g.edits.length} to review`) : `all ${g.count} reviewed`} · ${g.files} file${g.files > 1 ? 's' : ''}${syms ? ` · ${syms.length} declarations` : ''}`,
      nav: true,
      action: `<button type="button" class="btn${ok ? '' : ' primary'}" data-act="mark-group" data-group-id="${g.id}">${ok ? 'Mark all unreviewed' : `Mark all ${g.count} reviewed`}</button>`,
      below: `<p class="fv-note">${e0.op === 'token' ? 'A token replaced, as ' + esc(e0.where) : cap(esc(e0.op)) + ' of ' + esc(e0.where)}${g.parts.length > 1 ? `, with ${g.parts.length - 1} more edit${g.parts.length > 2 ? 's' : ''} that always come${g.parts.length > 2 ? '' : 's'} with it` : ''}.</p>`,
    });
    if (!syms) return h + instancesHtml(g, null, 'group' + g.id);
    syms.forEach((sy, i) => {
      const blocks = sy.edits.map((id) => M().blockById.get(M().edits[id].b)).filter((b, k, arr) => arr.indexOf(b) === k);
      const done2 = sy.edits.every((x) => rev().has(x));
      h += `<div class="sym-h"><b class="mono">${esc(sy.label || 'unresolved')}</b><span>${sy.edits.length} place${sy.edits.length > 1 ? 's' : ''}</span><span class="sp"></span><span class="hov"><button type="button" class="btn xs" data-act="mark-edits" data-edits="${sy.edits.join(' ')}">${done2 ? (sy.edits.length > 1 ? 'Mark these unreviewed' : 'Mark it unreviewed') : sy.edits.length > 1 ? `Mark these ${sy.edits.length} reviewed` : 'Mark it reviewed'}</button></span></div>`
        + instancesHtml(g, blocks, 'group' + g.id + ':' + i);
    });
    return h;
  }
  const repoSearches = new Map();
  function repoSearch(side, q) {
    const key = side + '\0' + q;
    if (!repoSearches.has(key)) {
      const r = { status: 'loading' };
      repoSearches.set(key, r);
      api('search?' + new URLSearchParams({ side, q })).then((x) => x.json().then((j) => { if (!x.ok) throw new Error(j.error || x.status); return j; }))
        .then((j) => Object.assign(r, { status: 'ok', results: j.results, truncated: j.truncated }))
        .catch((e) => Object.assign(r, { status: 'error', error: e.message }))
        .then(() => { if (state.view.kind === 'search' && state.search.q.trim() === q) render(); });
    }
    return repoSearches.get(key);
  }
  function scopesHtml() {
    const b = (k, label, title) => `<button type="button" data-scope="${k}" aria-pressed="${state.search.scope === k}" title="${esc(title)}">${label}</button>`;
    return `<span class="mini-seg" role="group" aria-label="Search in">${b('unreviewed', 'To review', 'Changed lines not reviewed yet')}${b('all', 'All changes', 'Every changed line')}${CONFIG.served ? b('repo-head', 'Repository', 'Every file, after these changes') + b('repo-base', 'Before', 'Every file, before these changes') : ''}</span>`;
  }
  // A result's colors, highlighted once: a search can find hundreds of lines.
  const resultColors = new WeakMap();
  function colorsOfResult(x) {
    if (!shikiOn) return null;
    if (!resultColors.has(x)) resultColors.set(x, lineColors(x.text, x.p));
    return resultColors.get(x);
  }
  function renderRepoSearch(side, q) {
    const r = repoSearch(side, q);
    let h = headerHtml({
      crumbs: `<span>Search</span>${SEP}<b class="ui">“${esc(q)}”</b>`,
      facts: `${r.status === 'ok' ? `${r.results.length}${r.truncated ? '+' : ''} line${r.results.length === 1 ? '' : 's'} in the repository` : 'The repository'}, ${side === 'base' ? 'before these changes' : 'after them'} · ${esc(((side === 'base' ? CONFIG.base : CONFIG.head) || '').slice(0, 7))}`,
      action: scopesHtml(),
    });
    if (q.length < 2) return h + '<div class="empty">Type at least two characters.</div>';
    if (r.status === 'loading') return h + '<div class="empty">Searching…</div>';
    if (r.status === 'error') return h + `<div class="empty">${esc(r.error)}</div>`;
    if (!r.results.length) return h + '<div class="empty">No line in the repository matches.</div>';
    // Generated files last.
    const list = r.results.slice().sort((a, b) => (a.generated - b.generated) || 0);
    h += '<div class="code">';
    let last = null;
    list.forEach((x) => {
      if (x.p !== last) { h += `<div class="inst-file">${sourceButton({ side, p: x.p }, esc(x.p), 'linkish')}${x.generated ? ' <span class="gen-tag">generated</span>' : ''}</div>`; last = x.p; }
      // Each line highlighted as the file's code, with names that ask the language server where
      // they're defined; a peek opens under its line.
      const file = { p: x.p, lang: C.langOf(x.p) };
      h += `<div class="ln ctx${file.lang === 'md' ? ' md' : ''}"><span class="g"></span><span class="no wide">${sourceButton({ side, p: x.p, line: x.l }, String(x.l), 'linkish')}</span><span class="sg"></span><span class="tx">${codeHtml(file, x.text, null, { colors: colorsOfResult(x), live: { side, p: x.p, line: x.l }, find: q })}</span></div>`
        + (side === 'base' ? peekAfterOld(file, x.l) : peekAfter(file, x.l));
    });
    if (r.truncated) h += `<div class="empty">The first ${r.results.length} matches. Make the search more precise for the rest.</div>`;
    return h + '</div>';
  }
  function renderSearch() {
    if (state.search.scope.startsWith('repo-')) return renderRepoSearch(state.search.scope.slice(5), state.search.q.trim());
    const q = state.search.q.trim().toLowerCase();
    const m = M();
    const res = [];
    m.files.forEach((f) => f.blocks.forEach((b) => {
      if (!b.edits.length || (state.search.scope === 'unreviewed' && done(b))) return;
      const hunk = f.hunks[b.hunk];
      for (let i = b.first; i < b.first + b.len; i++) if (hunk.rows[i][1].toLowerCase().includes(q)) res.push({ f, b, hunk, i });
    }));
    let h = headerHtml({
      crumbs: `<span>Search</span>${SEP}<b class="ui">“${esc(state.search.q)}”</b>`,
      facts: `${res.length} changed line${res.length === 1 ? '' : 's'}${state.search.scope === 'unreviewed' ? ' to review' : ''}`,
      action: scopesHtml(),
    });
    h += '<div class="code">';
    let last = null;
    res.slice(0, 400).forEach(({ f, b, hunk, i }) => {
      if (f !== last) { h += `<div class="inst-file"><button type="button" class="linkish" data-open="${esc(f.p)}">${pathHtml(f.p)}</button></div>`; last = f; }
      const meta = hunk.meta[i], [, text, ranges] = hunk.rows[i];
      const n = meta.t !== '-' ? meta.n : null, oldNo = meta.t === '-' ? meta.o : null;
      // Each line as the diff shows it, its changed tokens and names that peek at their
      // definitions; a peek opens under its line.
      const code = codeHtml(f, text, ranges, { emphasis: b.adds > 0 && b.dels > 0, n, o: oldNo, refs: true, colors: rowColors(hunk.rows, f.p, i), find: q });
      h += `<div class="ln ${meta.t === '+' ? 'add' : 'del'}${f.lang === 'md' ? ' md' : ''}"><span class="g"></span><span class="no wide"><button type="button" class="linkish" data-open="${esc(f.p)}" data-line="${n != null ? n : ''}">${n != null ? n : oldNo}</button></span><span class="sg">${meta.t === '+' ? '+' : '−'}</span><span class="tx">${code}</span></div>`
        + (n != null ? peekAfter(f, n) : peekAfterOld(f, oldNo));
    });
    if (!res.length) h += `<div class="empty">No changed line matches.${CONFIG.served ? ' “Repository” searches every file.' : ''}</div>`;
    return h + '</div>';
  }

  // ---------- commits: the history as a graph, in the sidebar's Commits tab and the History view
  const hxOn = () => !!HX && state.compare === 'base';
  const shortSha = (sha) => sha.slice(0, 7);
  const CONV = /^(\w+)(\(([^)]*)\))?!?:\s*(.*)$/;
  // A message as a row shows it: a conventional prefix ("feat(database)") apart, and a body run
  // into a long subject cut off.
  function subjectOf(c) {
    const s = c.subject.length > 90 && c.subject.includes(' - ') ? c.subject.slice(0, c.subject.indexOf(' - ')).trim() : c.subject.trim();
    const m = CONV.exec(s);
    if (!m || !m[4]) return { text: s, kind: '' };
    return { text: m[4][0].toUpperCase() + m[4].slice(1), kind: m[1] + (m[3] ? `(${m[3]})` : '') };
  }
  const thisYear = new Date().getFullYear();
  const dayOf = (sec) => { const d = new Date(sec * 1000); return d.toLocaleDateString('en-US', d.getFullYear() === thisYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }); };
  const whenOf = (sec) => `${dayOf(sec)}, ${new Date(sec * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  // The base's branch, as the review names it ("main · 1a2b3c4").
  const baseName = () => { const l = (M().raw.label || '').split(' · ')[0].trim(); return l && !/^[0-9a-f]{7,40}$/.test(l) ? l : 'the base'; };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  let commitMemo = null;
  // Per commit, the changes it wrote lines of.
  function commitParts() {
    if (commitMemo) return commitMemo;
    const per = HISTORY.commits.map(() => []);
    M().files.forEach((f) => (f.blocks || []).forEach((b) => { if (b.edits.length) blockCommits(b).forEach((ci) => per[ci] && per[ci].push(b)); }));
    return (commitMemo = per);
  }
  // A commit's changes: how many, how many still to review (its lines in them), and so its dot.
  function commitState(ci) {
    let open = 0;
    const list = commitParts()[ci];
    list.forEach((b) => { if (!commitDone(b, ci)) open++; });
    return { total: list.length, open, state: !list.length ? 'gone' : open ? 'left' : 'done' };
  }

  // ---------- lanes, after VS Code's Source Control Graph: toISCMHistoryItemViewModelArray and
  // renderSCMHistoryItemGraph in src/vs/workbench/contrib/scm/browser/scmHistory.ts, Copyright (c)
  // Microsoft Corporation, MIT License. Each row has the lanes coming in from above and going out
  // below, each lane named by the commit it leads to. Here a commit without parents (the branch's
  // start, or parents left outside the review) ends its own lane and no other.
  function laneModels(items) {
    const out = [];
    items.forEach((item, n) => {
      const input = n ? out[n - 1].output.map((x) => ({ ...x })) : [];
      const output = [];
      let firstAdded = false;
      for (const node of input) {
        if (node.id === item.id) {
          if (!firstAdded && item.parents.length) { output.push({ id: item.parents[0], k: node.k }); firstAdded = true; }
          continue;
        }
        output.push({ ...node });
      }
      const k0 = item.ghost ? 'ghost' : n === 0 ? 'main' : 'side';
      for (let i = firstAdded ? 1 : 0; i < item.parents.length; i++) output.push({ id: item.parents[i], k: i === 0 ? k0 : item.ghost ? 'ghost' : 'side' });
      out.push({ item, input, output });
    });
    return out;
  }
  const laneAt = (vm) => { const i = vm.input.findIndex((n) => n.id === vm.item.id); return i !== -1 ? i : vm.input.length; };
  // Room for the widest row: g = { W: between lanes, H: a row, pad, flagH: a flag's row }.
  function laneGeom(models, W, H, pad, flagH) {
    let lanes = 1, stub = false;
    models.forEach((vm) => { lanes = Math.max(lanes, vm.input.length, vm.output.length, laneAt(vm) + 1); if (vm.item.c && vm.item.c.brought) stub = true; });
    return { W, H, pad, flagH, width: pad * 2 + (lanes - 1 + (stub ? 1 : 0)) * W };
  }
  function laneSvg(vm, g, dot, extra) {
    const { item, input, output } = vm;
    const X = (i) => g.pad + i * g.W, H = g.H, mid = H / 2;
    const found = input.findIndex((n) => n.id === item.id);
    const ci = found !== -1 ? found : input.length;
    const kOf = ci < output.length ? output[ci].k : found !== -1 ? input[found].k : item.ghost ? 'ghost' : 'side';
    let d = '';
    const seg = (path, k) => { d += `<path class="lane ${k}" d="${path}"/>`; };
    let oi = 0;
    input.forEach((n, i) => {
      if (n.id === item.id) {
        // Another lane that leads here joins the commit.
        if (i !== ci) seg(`M${X(i)} 0C${X(i)} ${mid * 0.7} ${X(ci)} ${mid * 0.3} ${X(ci)} ${mid}`, n.k);
        else if (item.parents.length) oi++;
        return;
      }
      if (oi < output.length && n.id === output[oi].id) {
        seg(i === oi ? `M${X(i)} 0V${H}` : `M${X(i)} 0C${X(i)} ${H * 0.55} ${X(oi)} ${H * 0.45} ${X(oi)} ${H}`, n.k);
        oi++;
      }
    });
    // A merge's other parents, on the lanes that lead to them.
    for (let p = 1; p < item.parents.length; p++) {
      let at = -1;
      for (let j = output.length - 1; j >= 0; j--) if (output[j].id === item.parents[p]) { at = j; break; }
      if (at >= 0) seg(`M${X(ci)} ${mid}C${X(at)} ${mid} ${X(at)} ${mid} ${X(at)} ${H}`, output[at].k);
    }
    if (found !== -1) seg(`M${X(ci)} 0V${mid}`, input[found].k);
    if (item.parents.length) seg(`M${X(ci)} ${mid}V${H}`, kOf);
    return `<svg class="lanes" width="${g.width}" height="${H}" viewBox="0 0 ${g.width} ${H}" aria-hidden="true">${d}${extra ? extra(X(ci), mid) : ''}${dot(X(ci), mid)}</svg>`;
  }
  // A row between commits: the lanes passing through, a flag on one of them.
  function laneThrough(lanes, g, flagAt) {
    const H = g.flagH;
    let d = lanes.map((n, i) => `<path class="lane ${n.k}" d="M${g.pad + i * g.W} 0V${H}"/>`).join('');
    if (flagAt >= 0) { const x = g.pad + flagAt * g.W, y = H / 2; d += `<path class="flag" d="M${x - 4.5} ${y - 6}h9v12l-4.5-3.4-4.5 3.4z"/>`; }
    return `<svg class="lanes" width="${g.width}" height="${H}" viewBox="0 0 ${g.width} ${H}" aria-hidden="true">${d}</svg>`;
  }
  // A commit's dot: amber with changes to review, a check when they're reviewed, hollow when
  // nothing of it is left at the head; an old head's, dashed.
  const dotSvg = (st) => (x, y) => (st === 'left' ? `<circle class="dot left" cx="${x}" cy="${y}" r="4.5"/>`
    : st === 'done' ? `<circle class="dot done" cx="${x}" cy="${y}" r="5.5"/><path class="dot-check" d="M${x - 2.6} ${y}l1.8 1.9 3.4-3.6"/>`
      : `<circle class="dot ${st === 'ghost' ? 'ghost' : 'gone'}" cx="${x}" cy="${y}" r="4.5"/>`);
  // Where a merge's other parent comes from: outside the review, folded into a stub.
  const stubSvg = (g) => (x, y) => `<path class="lane stub" d="M${x} ${y}C${x + g.W * 0.9} ${y} ${x + g.W} ${y + 4} ${x + g.W} ${g.H - 7}"/><rect class="stub-end" x="${x + g.W - 3}" y="${g.H - 10}" width="6" height="6" rx="1.2" transform="rotate(45 ${x + g.W} ${g.H - 7})"/>`;

  // The graph's rows: the commits, and the old heads (a force push's, or the one of your review
  // when the branch no longer has it) at their time, above where they left the branch.
  function graphItems() {
    const items = HISTORY.commits.map((c, i) => ({ id: c.sha, parents: c.parents, c, i }));
    ((HX.live && HX.live.ghosts) || []).forEach((gh) => {
      const item = { id: 'g:' + gh.sha, parents: gh.fork ? [gh.fork] : [], ghost: gh };
      let at = items.findIndex((x) => (x.c ? x.c.at : x.ghost.at) < gh.at);
      at = Math.max(1, at < 0 ? items.length : at);
      const fi = gh.fork ? items.findIndex((x) => x.id === gh.fork) : -1;
      if (fi >= 0 && fi < at) at = fi;
      items.splice(at, 0, item);
    });
    return laneModels(items);
  }
  // Your last review of another head, when that head is in the branch: its flag's place.
  const reviewInBranch = () => { const rv = HX.live && HX.live.review; return rv && rv.inBranch && rv.here ? rv : null; };
  const isReviewLens = () => !!state.lens && state.lens.kind === 'since' && state.lens.why === 'review';
  const commitInLens = (ci) => { const d = lensData(); return !!d && !!d.set && d.set.has(ci); };

  // `chain`: the chain open, which the list follows ({ writers, own }): a commit that wrote some of
  // its lines says in how many of its changes, one of its own commits is ringed, the others fade.
  function commitRowHtml(vm, g, chain) {
    const it = vm.item;
    if (it.ghost) return ghostRowHtml(vm, g, 'cm-row');
    const c = it.c, st = commitState(it.i), sub = subjectOf(c), on = commitInLens(it.i);
    const w = chain && chain.writers.get(it.i), own = !!chain && chain.own.has(it.i);
    const stub = c.brought ? stubSvg(g) : null;
    const svg = laneSvg(vm, g, dotSvg(st.state), own ? (x, y) => (stub ? stub(x, y) : '') + `<circle class="ring" cx="${x}" cy="${y}" r="8"/>` : stub);
    const cnt = st.state === 'left' ? `<span class="cm-n left">${st.open}</span>` : st.state === 'done' ? `<span class="cm-n ok">${ICON.check}</span>` : '<span class="cm-n">—</span>';
    const meta = (c.brought ? `<code>${shortSha(c.sha)}</code> · brings ${plural(c.brought, 'commit')} from ${esc(baseName())}` : `<code>${shortSha(c.sha)}</code>${sub.kind ? ' · ' + esc(sub.kind) : ''} · ${dayOf(c.at)}`) + (w ? ` · <b>${w.changes} here</b>` : '');
    const left = st.total ? `${plural(st.total, 'change')}${st.open ? `, ${st.open} to review` : ', all reviewed'}` : 'Nothing of it is left at the head';
    const here = !chain ? '' : w ? `\n${own ? 'The open chain’s commit. ' : ''}Its lines are in ${w.changes} of the open chain’s changes.` : '\nNone of its lines are in the open chain.';
    return `<button type="button" class="cm-row${on ? ' in' : ''}${st.state === 'gone' ? ' gone' : ''}${w ? ' mine' : ''}" data-commit="${c.sha}" data-ci="${it.i}" aria-pressed="${on}" title="${esc(`${c.subject}\n${shortSha(c.sha)} · ${c.author} · ${whenOf(c.at)}\n${left}.${here}\n\nClick for its changes; Shift-click for a range.`)}">${svg}<span class="cm-s">${esc(sub.text)}</span><span class="cm-m">${meta}</span>${commitDiff(c)}${cnt}</button>`;
  }
  function ghostRowHtml(vm, g, cls) {
    const gh = vm.item.ghost, on = !!state.lens && state.lens.kind === 'since' && state.lens.from === gh.sha;
    const who = gh.actor ? `Force-pushed by ${esc(gh.actor)}` : 'Your review, of a head the branch no longer has';
    const meta = `<code>${shortSha(gh.sha)}</code> · ${dayOf(gh.at)}${gh.replaced ? ` · ${plural(gh.replaced, 'commit')} replaced` : ''}${gh.yours && gh.actor ? ' · your review' : ''}`;
    const title = gh.here ? `The head before${gh.actor ? ' this force push' : ''}: ${shortSha(gh.sha)}. Click for what changed since.` : 'GitHub no longer has this head';
    const inner = cls === 'lp-row' ? `${laneSvg(vm, g, dotSvg('ghost'))}<code>${shortSha(gh.sha)}</code><span class="lp-s">${who}</span><span class="cm-n"></span>`
      : `${laneSvg(vm, g, dotSvg('ghost'))}<span class="${cls === 'cm-row' ? 'cm-s' : 'hs-s'}">${who}</span><span class="${cls === 'cm-row' ? 'cm-m' : 'hs-m'}">${meta}</span>${cls === 'cm-row' ? '<span class="cm-n"></span>' : ''}`;
    return `<button type="button" class="${cls} old-head${on ? ' in' : ''}" data-act="lens-ghost" data-sha="${gh.sha}" data-why="${gh.yours ? 'review' : 'push'}" aria-pressed="${on}"${gh.here ? '' : ' disabled'} title="${esc(title)}">${inner}</button>`;
  }
  function flagRowHtml(vm, g, cls) {
    const rv = reviewInBranch();
    return `<button type="button" class="${cls}${isReviewLens() ? ' in' : ''}" data-act="lens-review" title="Show only what changed since your last review, at ${shortSha(rv.head)}">${laneThrough(vm.input, g, vm.input.findIndex((n) => n.id === rv.head))}<span>Your review</span><b>${whenOf(rv.at)}</b></button>`;
  }
  const preset = (act, label, n, on, title, diff) => `<button type="button" class="sb-row cm-pre" data-act="${act}" aria-pressed="${on}" title="${esc(title)}"><i class="rd"></i><span class="nm ui">${label}</span>${diff || ''}<span class="cnt">${n || ''}</span></button>`;
  // The open changes since an older head (its rows loaded), as a lens there would count them.
  function sinceOpen(from) {
    const rows = HX.since.get(from);
    if (!rows) return 0;
    let n = 0;
    M().files.forEach((f) => {
      const r = rows[f.idx];
      if (r) (f.blocks || []).forEach((b) => {
        const hr = r[b.hunk];
        if (!hr || !b.edits.length || done(b)) return;
        for (let ri = b.first; ri < b.first + b.len; ri++) if (hr.has(ri)) { n++; break; }
      });
    });
    return n;
  }
  // The sidebar's Commits tab: the History view and the lens's presets (pinned at the top), then the
  // graph, which follows the chain open: its commits stand out, and hovering one dims the lines it
  // didn't write.
  function commitsTabHtml() {
    const models = graphItems(), g = laneGeom(models, 12, 40, 8, 26);
    const rv = HX.live && HX.live.review, m = M();
    const all = withoutLens(() => stats(m.files.flatMap((f) => f.blocks)));
    const open = state.view.kind === 'chain' ? m.chains[state.view.id] : null;
    const chain = open && chainWriters(open).size ? { writers: chainWriters(open), own: new Set(m.byCommit ? familyCommits(m.families.find((f) => f.id === open.family)) : []) } : null;
    let pin = `<button type="button" class="sb-row map" data-act="history-open"${state.view.kind === 'history' ? ' aria-current="true"' : ''} title="Every commit, with what it touched, its checks and its reviews"><span class="tw">${ICON.history}</span><span class="nm ui">History</span><span class="cnt"></span></button>`;
    pin += preset('lens-all', 'All changes', all.open, !state.lens, 'Every change of the pull request', filesDiff(m.files));
    if (rv && rv.here) pin += preset('lens-review', 'Since your review', sinceOpen(rv.head), isReviewLens(), `What changed since the head of your last review, ${shortSha(rv.head)} (${whenOf(rv.at)})`);
    let h = `<div class="sb-group"><span>Commits</span><span${chain ? ' title="The commits that wrote lines of the chain open"' : ''}>${chain ? `${chain.writers.size} of ${HISTORY.commits.length} in this chain` : HISTORY.commits.length}</span></div><div class="cm-list${chain ? ' follow' : ''}" role="group" aria-label="The commits, newest first">`;
    const rvb = reviewInBranch();
    models.forEach((vm) => {
      if (rvb && vm.item.id === rvb.head) h += flagRowHtml(vm, g, 'cm-flag');
      h += commitRowHtml(vm, g, chain);
    });
    const last = HISTORY.commits[HISTORY.commits.length - 1];
    if (last.outside[0]) h += `<div class="cm-start" title="The branch starts after ${esc(last.outside[0])}">Branched from <code>${shortSha(last.outside[0])}</code></div>`;
    return { pin, list: h + '</div>' };
  }

  // ---------- "Changes from": the head commit's popover in the top bar. The lens's presets, then
  // the graph, a line per commit; a click picks one (Shift: a range from the last one picked) and
  // closes it.
  function lensPopHtml() {
    const models = graphItems(), g = laneGeom(models, 12, 30, 10, 24);
    const rv = HX.live && HX.live.review;
    const all = withoutLens(() => stats(M().files.flatMap((f) => f.blocks)));
    const pre = (data, label, sub, n, on, title) => `<button type="button" class="lp-pre"${dataAttrs(data)} aria-pressed="${on}" title="${esc(title)}"><i class="rd"></i><span>${label}${sub ? `<em>${sub}</em>` : ''}</span><b>${n || ''}</b></button>`;
    let h = `<div class="lp-h"><b>Changes from</b><span>${plural(HISTORY.commits.length, 'commit')} · head <code>${shortSha(HISTORY.commits[0].sha)}</code></span></div><div class="lp-pres">`;
    h += pre({ act: 'lens-all' }, 'All changes', '', all.open, !state.lens, 'Every change of the pull request');
    if (rv && rv.here) { const k = HX.index.get(rv.head); h += pre({ act: 'lens-review' }, 'Since your review', `${dayOf(rv.at)}${k ? ' · ' + plural(k, 'commit') : ''}`, sinceOpen(rv.head), isReviewLens(), `What changed since the head of your last review, ${shortSha(rv.head)} (${whenOf(rv.at)})`); }
    // The branch's own newest commit with changes: not a merge.
    const last = HISTORY.commits.findIndex((c, i) => c.parents.length + c.outside.length < 2 && commitState(i).total);
    if (last >= 0) {
      const c = HISTORY.commits[last], on = !!state.lens && state.lens.kind === 'commits' && state.lens.shas.length === 1 && state.lens.shas[0] === c.sha;
      h += pre({ commit: c.sha }, 'The last commit with changes', `<code>${shortSha(c.sha)}</code>`, commitState(last).open, on, c.subject);
    }
    h += '</div><div class="lp-list" role="group" aria-label="The commits, newest first">';
    const rvb = reviewInBranch();
    models.forEach((vm) => {
      if (rvb && vm.item.id === rvb.head) h += flagRowHtml(vm, g, 'lp-flag');
      h += popRowHtml(vm, g);
    });
    return h + '</div><div class="lp-f"><span>Click a commit for its changes, Shift-click for a range</span><button type="button" class="btn xs" data-act="history-open" title="Every commit in full: its details, checks and reviews">History</button></div>';
  }
  function popRowHtml(vm, g) {
    const it = vm.item;
    if (it.ghost) return ghostRowHtml(vm, g, 'lp-row');
    const c = it.c, st = commitState(it.i), on = commitInLens(it.i);
    const svg = laneSvg(vm, g, dotSvg(st.state), c.brought ? stubSvg(g) : null);
    const cnt = st.state === 'left' ? `<span class="cm-n left">${st.open}</span>` : st.state === 'done' ? `<span class="cm-n ok">${ICON.check}</span>` : '<span class="cm-n">—</span>';
    const left = st.total ? `${plural(st.total, 'change')}${st.open ? `, ${st.open} to review` : ', all reviewed'}` : 'Nothing of it is left at the head';
    return `<button type="button" class="lp-row${on ? ' in' : ''}${st.state === 'gone' ? ' gone' : ''}" data-commit="${c.sha}" aria-pressed="${on}" title="${esc(`${c.subject}\n${shortSha(c.sha)} · ${c.author} · ${whenOf(c.at)}\n${left}.`)}">${svg}<code>${shortSha(c.sha)}</code><span class="lp-s">${esc(subjectOf(c).text)}</span>${cnt}</button>`;
  }

  // ---------- the History view: each commit in full, what it touched, its checks and reviews
  const CHECK = { SUCCESS: ['ok', 'Checks passed'], FAILURE: ['bad', 'Checks failed'], ERROR: ['bad', 'Checks errored'], PENDING: ['wait', 'Checks running'], EXPECTED: ['wait', 'Checks expected'] };
  const REVIEW_WORD = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'commented', DISMISSED: 'dismissed' };
  function histRowHtml(vm, g) {
    const it = vm.item;
    if (it.ghost) return `<div class="hs-row old-head${state.lens && state.lens.kind === 'since' && state.lens.from === it.ghost.sha ? ' in' : ''}">${ghostRowHtml(vm, g, 'hs-main')}</div>`;
    const c = it.c, st = commitState(it.i), sub = subjectOf(c), on = commitInLens(it.i), m = M();
    const svg = laneSvg(vm, g, dotSvg(st.state), c.brought ? stubSvg(g) : null);
    // The chains it touched, the most first.
    const perChain = new Map();
    commitParts()[it.i].forEach((b) => (m.chainsOf.get(b.id) || []).forEach((id) => perChain.set(id, (perChain.get(id) || 0) + 1)));
    const top = [...perChain].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, 2);
    const chips = top.map(([id, n]) => { const ch = m.chains[id], nm = splitName(ch.name); return `<button type="button" class="hs-chip" data-act="lens-chain" data-sha="${c.sha}" data-chain-id="${id}" title="${esc(ch.name)}: open it, through this commit"><i class="${stats(blocksOf(ch.blocks)).open ? '' : 'ok'}"></i>${esc(trunc(nm.name, 26))}<em>${n}</em></button>`; }).join('');
    const facts = HX.live && HX.live.github;
    const ck = facts && facts.checks[c.sha] && CHECK[facts.checks[c.sha]];
    const reviews = new Map();
    (facts ? facts.reviews : []).forEach((r) => { if (r.sha !== c.sha) return; const k = r.author.login + ' ' + r.state; if (!reviews.has(k)) reviews.set(k, { ...r, n: 0 }); reviews.get(k).n++; });
    const rv = [...reviews.values()].map((r) => `<a class="hs-rev ${r.state === 'APPROVED' ? 'ok' : r.state === 'CHANGES_REQUESTED' ? 'bad' : ''}" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" title="${esc(r.author.login)} ${REVIEW_WORD[r.state] || r.state.toLowerCase()} on this commit${r.n > 1 ? `, ${r.n} times` : ''}">${r.author.avatar ? `<img src="${esc(r.author.avatar)}&s=32" alt="" width="16" height="16">` : ''}<span>${esc(`${r.author.login} ${REVIEW_WORD[r.state] || ''}${r.n > 1 ? ` ×${r.n}` : ''}`.trim())}</span></a>`).join('');
    const what = c.brought ? `brings ${plural(c.brought, 'commit')} from ${esc(baseName())}` : st.total ? `${plural(st.total, 'change')} ${perChain.size ? 'in ' + plural(perChain.size, 'chain') : 'outside chains'}` : 'nothing of it left at the head';
    const meta = `<code>${shortSha(c.sha)}</code>${sub.kind ? ' · ' + esc(sub.kind) : ''} · ${esc(c.author)} · ${dayOf(c.at)} · ${what}`;
    const cnt = st.state === 'left' ? `<span class="hs-n left" title="${st.open} of its changes to review">${st.open}</span>` : st.state === 'done' ? `<span class="hs-n ok" title="All of it reviewed">${ICON.check}</span>` : '<span class="hs-n">—</span>';
    const open = HX.open.has(c.sha), shown = HX.detail === c.sha;
    const more = c.brought && CONFIG.served ? `<button type="button" class="btn xs" data-act="brought" data-sha="${c.sha}" aria-expanded="${open}">${open ? 'Hide them' : 'Show them'}</button>` : '';
    return `<div class="hs-row${on ? ' in' : ''}${shown ? ' open' : ''}${st.state === 'gone' ? ' gone' : ''}"><button type="button" class="hs-main" data-detail="${c.sha}" aria-expanded="${shown}" title="${esc(`${c.subject}\n${shortSha(c.sha)} · ${c.author} · ${whenOf(c.at)}\n\nClick for its details; Shift-click for the changes of the commits from the last one clicked to this one.`)}">${svg}<span class="hs-s">${esc(sub.text)}</span><span class="hs-m">${meta}</span></button>`
      + `<span class="hs-x">${more}${rv}${chips}</span><span class="hs-ci${ck ? ' ' + ck[0] : ''}"${ck ? ` title="${ck[1]}"` : ''}>${ck ? (ck[0] === 'ok' ? ICON.check : ck[0] === 'bad' ? ICON.close : '•') : ''}</span>${cnt}</div>`;
  }
  // The commits a merge brought from the base's branch, under it.
  function broughtHtml(vm, g) {
    const sha = vm.item.c.sha, got = HX.brought.get(sha);
    const lanes = laneThrough(vm.output, { ...g, flagH: 30 }, -1);
    if (!got) return `<div class="hs-sub">${lanes}<span class="muted">Loading…</span></div>`;
    if (got.error) return `<div class="hs-sub">${lanes}<span class="muted">${esc(got.error)}</span></div>`;
    return got.commits.map((x) => `<div class="hs-sub" title="${esc(x.subject)}">${lanes}<code>${shortSha(x.sha)}</code><span class="hs-sub-s">${esc(x.subject)}</span><span class="muted">${esc(x.author)} · ${dayOf(x.at)}</span></div>`).join('')
      + (got.more ? `<div class="hs-sub">${lanes}<span class="muted">and more: the first ${got.commits.length} are listed</span></div>` : '');
  }
  // ---------- a commit's details, under its row, as Git Graph shows them: the commit, its parents,
  // who wrote and committed it and when, its message, and the files it changed (a tree or a list),
  // each with what's left to review of the commit there. A file opens with the commit as the lens.
  const fullWhen = (sec) => new Date(sec * 1000).toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short' });
  // The repository on GitHub, from the pull request's address: where a message's "#123" points.
  const repoUrl = () => { const m = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/.exec(CONFIG.url || ''); return m ? m[1] : null; };
  const linkTo = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  // A message as text, with `code` as code, and its addresses and "#123"s as links.
  function messageHtml(text) {
    const repo = repoUrl();
    return esc(text).split(/(`[^`\n]+`)/).map((part, i) => (i % 2 ? `<code>${part.slice(1, -1)}</code>`
      : part.replace(/\bhttps?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]]/g, (u) => linkTo(u, u))
        .replace(/(^|[\s([])#(\d+)\b/g, (all, pre, n) => (repo ? pre + linkTo(`${repo}/issues/${n}`, '#' + n) : all)))).join('');
  }
  // A commit's files, each with its place in the review: the commit's changes there (`total`, and
  // `open` to review), generated, or not in the review.
  function commitFilesOf(ci) {
    const c = HISTORY.commits[ci], m = M();
    const files = new Map(m.files.map((f) => [f.p, f])), gen = new Set(m.generated.map((f) => f.p));
    const total = new Map(), open = new Map();
    commitParts()[ci].forEach((b) => { const p = b.file.p; total.set(p, (total.get(p) || 0) + 1); if (!commitDone(b, ci)) open.set(p, (open.get(p) || 0) + 1); });
    return (c.files || []).map(([pi, s, a, d, from]) => {
      const p = HISTORY.paths[pi];
      return { p, s, a, d, from: from != null ? HISTORY.paths[from] : null, f: files.get(p) || null, gen: gen.has(p), total: total.get(p) || 0, open: open.get(p) || 0 };
    });
  }
  // The first line a commit wrote in a file, at the head (a removed line's: the line after it, or
  // the line before it when the file ends there).
  const FILE_STATUS = { A: 'added', M: 'changed', D: 'deleted', R: 'renamed', C: 'copied', T: 'changed in type' };
  function detailFileHtml(x, sha, depth, g, flat) {
    const at = x.p.lastIndexOf('/');
    const name = flat && at > 0 ? `<span class="own">${esc(x.p.slice(0, at + 1))}</span><span class="fn">${esc(x.p.slice(at + 1))}</span>` : `<span class="fn">${esc(fileName(x.p))}</span>`;
    const from = x.from ? `<span class="sn">from ${esc(flat || x.from.slice(0, x.from.lastIndexOf('/')) !== x.p.slice(0, at) ? x.from : fileName(x.from))}</span>` : '';
    const lines = x.a < 0 ? 'binary' : `<span class="a">+${fmt(x.a)}</span><span class="d">−${fmt(x.d)}</span>`;
    const mark = x.f ? (x.open ? '<i class="mk"></i>' : x.total ? `<i class="mk ok">${ICON.check}</i>` : '<i class="mk out"></i>') : x.gen ? '<i class="mk gen"></i>' : '<i class="mk away"></i>';
    const where = x.f ? (x.open ? `${plural(x.open, 'change')} of this commit to review` : x.total ? 'this commit’s changes reviewed' : 'nothing of this commit left at the head') : x.gen ? 'generated, not reviewed' : 'not in this review';
    const title = `${x.p}${x.from ? `, from ${x.from}` : ''}: ${FILE_STATUS[x.s] || x.s}, ${where}`;
    const inner = `${g}${mark}<span class="nm">${name}${from}</span><span class="cnt">${lines}</span>`;
    const cls = `sb-row tr s-${x.s.toLowerCase()}${x.gen ? ' gen' : ''}`;
    return `<button type="button" class="${cls}${!x.f && !x.gen ? ' away' : ''}" data-act="hd-open" data-p="${esc(x.p)}" data-sha="${sha}" style="--d:${depth}" title="${esc(title + '. Click to read the file here, at this commit')}">${inner}</button>`;
  }
  // As a tree, folders first; a folder that holds only a folder shows with it, as in the Files tab.
  function detailFilesHtml(list, sha) {
    if (UI.filesList) return list.map((x) => detailFileHtml(x, sha, 0, '', true)).join('');
    const rows = [];
    const walk = (nd, dp) => {
      [...nd.dirs.values()].sort((x, y) => byName(x.name, y.name)).forEach((d) => {
        let name = d.name;
        while (d.dirs.size === 1 && !d.files.length) { d = [...d.dirs.values()][0]; name += '/' + d.name; }
        const key = sha + ':' + d.path, open = !HX.closed.has(key);
        rows.push({ depth: dp, html: (g) => `<button type="button" class="sb-row tr dir" data-act="hd-dir" data-key="${esc(key)}" aria-expanded="${open}" style="--d:${dp}" title="${esc(d.path)}/">${g}<span class="tw">${open ? ICON.chevronDown : ICON.chevronRight}</span><span class="nm">${esc(name)}</span><span class="cnt"></span></button>` });
        if (open) walk(d, dp + 1);
      });
      nd.files.slice().sort((x, y) => byName(fileName(x.p), fileName(y.p))).forEach((x) => rows.push({ depth: dp, html: (g) => detailFileHtml(x, sha, dp, g, false) }));
    };
    walk(fileTree(list), 0);
    return treeRowsHtml(rows);
  }
  // `lanes`: the graph's lanes beside it, in History; none in a chain, where it opens on its own.
  function detailHtml(ci, lanes) {
    const c = HISTORY.commits[ci], st = commitState(ci), list = commitFilesOf(ci);
    const merge = c.parents.length + c.outside.length > 1;
    const parent = (p) => `<button type="button" class="linkish" data-act="hd-go" data-sha="${p}" title="${esc(HISTORY.commits[HX.index.get(p)].subject)}: its details"><code>${shortSha(p)}</code></button>`;
    const away = (p) => `<code title="${esc(p)}">${shortSha(p)}</code> <span class="muted">${merge ? 'from ' + esc(baseName()) : 'where the branch starts'}</span>`;
    const person = (name, email) => `${esc(name)}${email ? ` <span class="muted">&lt;<a href="mailto:${esc(email)}">${esc(email)}</a>&gt;</span>` : ''}`;
    const facts = [
      ['Commit', `<code>${c.sha}</code>`],
      ['Parents', [...c.parents.map(parent), ...c.outside.map(away)].join(', ') || '<span class="muted">none</span>'],
      ['Author', person(c.author, c.email)],
      c.cemail && (c.committer !== c.author || c.cemail !== c.email) ? ['Committer', person(c.committer, c.cemail)] : null,
      ['Date', esc(fullWhen(c.at))],
      c.cat && Math.abs(c.cat - c.at) > 60 ? ['Committed', esc(fullWhen(c.cat))] : null,
    ].filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    const msg = `<div class="hd-msg"><p class="hd-subj">${messageHtml(c.subject)}</p>${c.body ? `<p class="hd-text">${messageHtml(c.body)}</p>` : ''}</div>`;
    const only = !!state.lens && state.lens.kind === 'commits' && state.lens.shas.length === 1 && state.lens.shas[0] === c.sha;
    const acts = st.total
      ? `<div class="hd-acts">${st.open ? `<button type="button" class="btn primary sm" data-act="hd-review" data-sha="${c.sha}" title="Only this commit’s changes count, from the first chain with some to review">Review its changes · ${st.open}</button>` : ''}<button type="button" class="btn sm" data-act="hd-lens" data-sha="${c.sha}" aria-pressed="${only}" title="${only ? 'Back to every change (Esc)' : 'Only this commit’s changes count, in every view'}">${only ? ICON.check : ''}Only its changes</button></div>`
      : '<p class="hd-none">None of its lines are left at the head.</p>';
    const adds = list.reduce((n, x) => n + Math.max(0, x.a), 0), dels = list.reduce((n, x) => n + Math.max(0, x.d), 0);
    const against = merge && list.length ? ` · against <code>${shortSha(c.parents[0] || c.outside[0])}</code>, its first parent` : '';
    const fh = `<div class="hd-fh">${plural(list.length + (c.more || 0), 'file')}${list.length && !c.more ? ` · <span class="a">+${fmt(adds)}</span> <span class="d">−${fmt(dels)}</span>` : ''}${against}</div>`;
    const files = list.length ? detailFilesHtml(list, c.sha) + (c.more ? `<div class="hd-more">and ${fmt(c.more)} more</div>` : '') : '<div class="hd-more">No files changed</div>';
    const rail = `<div class="hd-rail">${iconBtn(ICON.close, 'Close (Esc)', 'data-act="hd-close"')}${iconBtn(ICON.listTree, 'Files as a tree', 'data-act="hd-view" data-v="tree"', { label: 'Files as a tree', on: !UI.filesList })}${iconBtn(ICON.listFlat, 'Files as a list', 'data-act="hd-view" data-v="list"', { label: 'Files as a list', on: !!UI.filesList })}</div>`;
    return `<div class="hs-detail${lanes ? '' : ' solo'}" data-detail-of="${c.sha}">${lanes}<div class="hd-in"><div class="hd-info"><dl class="hd-facts">${facts}</dl>${msg}${acts}</div><div class="hd-files">${fh}<div role="group" aria-label="The files it changed">${files}</div></div>${rail}${state.peek && state.peek.history && state.peek.history.sha === c.sha ? peekHtml(state.peek) : ''}</div></div>`;
  }
  function renderHistory() {
    if (!hxOn()) return headerHtml({ crumbs: '<b class="ui">History</b>' }) + '<div class="empty">git couldn’t tell this review’s commits.</div>';
    const models = graphItems(), g = laneGeom(models, 16, 56, 12, 30);
    const list = HISTORY.commits, merges = list.filter((c) => c.brought).length;
    const pushes = ((HX.live && HX.live.ghosts) || []).filter((x) => x.actor).length;
    const lensOpen = state.lens ? stats(M().files.flatMap((f) => f.blocks)).open : 0;
    const rv = HX.live && HX.live.review, fresh = !state.lens && rv && rv.here ? sinceOpen(rv.head) : 0;
    const action = lensOpen ? `<button type="button" class="btn primary" data-act="lens-go" title="The first chain with changes in the lens">Review these changes · ${lensOpen}</button>`
      : fresh ? `<button type="button" class="btn primary" data-act="lens-review" data-go="1" title="What changed since your last review, from the first chain with some">Review what’s new · ${fresh}</button>` : '';
    const span = list.length > 1 && dayOf(list[list.length - 1].at) !== dayOf(list[0].at) ? `${dayOf(list[list.length - 1].at)} – ${dayOf(list[0].at)}` : dayOf(list[0].at);
    let h = headerHtml({
      crumbs: '<b class="ui">History</b>',
      facts: `${plural(list.length, 'commit')}${merges ? ` · ${plural(merges, 'merge')} from ${esc(baseName())}` : ''}${pushes ? ` · ${plural(pushes, 'force push')}` : ''} · ${span}`,
      action,
    });
    const gh = HX.live && HX.live.githubError ? `<span class="d" title="${esc(HX.live.githubError)}">GitHub didn’t answer: no checks or reviews</span>` : '';
    h += `<div class="hs-legend"><span><i class="lg-left"></i>has changes to review</span><span><i class="lg-done"></i>reviewed</span><span><i class="lg-gone"></i>nothing of it left at the head</span><span><i class="lg-ghost"></i>a head before a force push</span>${gh}<span class="sp"></span><span>Newest first</span></div><div class="hist">`;
    const rvb = reviewInBranch();
    models.forEach((vm) => {
      if (rvb && vm.item.id === rvb.head) h += `<div class="hs-row">${flagRowHtml(vm, g, 'hs-flag')}</div>`;
      h += histRowHtml(vm, g);
      if (vm.item.c && HX.detail === vm.item.c.sha) h += detailHtml(vm.item.i, `<span class="lanes-v" style="width:${g.width}px" aria-hidden="true">${vm.output.map((n, i) => `<i class="${n.k}" style="left:${g.pad + i * g.W}px"></i>`).join('')}</span>`);
      if (vm.item.c && vm.item.c.brought && HX.open.has(vm.item.c.sha)) h += broughtHtml(vm, g);
    });
    const last = list[list.length - 1];
    if (last.outside[0]) h += `<div class="hs-start">Branched from ${esc(baseName())} at <code>${shortSha(last.outside[0])}</code></div>`;
    return h + '</div>';
  }

  // ---------- the lens: its name, and what turns it on
  function lensLabel() {
    const ln = state.lens;
    if (!ln) return '';
    if (ln.kind === 'since') {
      const k = HX.index.get(ln.from);
      if (ln.why === 'review') return k ? `Since your review · ${plural(k, 'commit')}` : 'Since your review';
      return `Since ${shortSha(ln.from)}, before the force push`;
    }
    if (ln.shas.length === 1) { const c = HISTORY.commits[HX.index.get(ln.shas[0])]; return `${shortSha(ln.shas[0])} · ${trunc(subjectOf(c).text, 30)}`; }
    return `${ln.shas.length} commits`;
  }
  // While no lens is on, a view's header offers what's new since your review. The lens, once on,
  // names itself on the head commit in the top bar.
  const LENS_VIEWS = new Set(['chain', 'file', 'standalone', 'group', 'map']);
  function lensOfferHtml() {
    if (!hxOn() || state.lens || !LENS_VIEWS.has(state.view.kind)) return '';
    const rv = HX.live && HX.live.review;
    const n = rv && rv.here ? sinceOpen(rv.head) : 0;
    return n ? `<button type="button" class="lens-offer" data-act="lens-review" title="Show only what changed since the head of your last review, ${shortSha(rv.head)}">New since your review<i>${n}</i></button>` : '';
  }
  // Going to a chain shows the chains in the sidebar, unless it shows the commits: they follow it.
  const toChains = () => { if (state.tab !== 'commits') state.tab = 'chains'; };
  function setLens(lens) {
    state.lens = lens;
    lensMemo = null;
    navAt = null;
    render();
  }
  function lensCommit(sha, range) {
    const i = HX.index.get(sha);
    if (i == null) return;
    if (range && HX.anchor != null && HX.anchor !== i) {
      const a = Math.min(HX.anchor, i), b = Math.max(HX.anchor, i);
      return setLens({ kind: 'commits', shas: HISTORY.commits.slice(a, b + 1).map((c) => c.sha) });
    }
    HX.anchor = i;
    const cur = state.lens;
    if (cur && cur.kind === 'commits' && cur.shas.length === 1 && cur.shas[0] === sha) return setLens(null);
    setLens({ kind: 'commits', shas: [sha] });
  }
  function fetchSince(from) {
    if (HX.since.has(from)) return Promise.resolve(HX.since.get(from));
    return api('since?from=' + from).then((r) => r.json()).then((j) => {
      if (!j.rows) throw new Error(j.error || 'not available');
      const rows = {};
      Object.entries(j.rows).forEach(([fi, hs]) => { rows[fi] = {}; Object.entries(hs).forEach(([hi, list]) => { rows[fi][hi] = new Set(list); }); });
      HX.since.set(from, rows);
      return rows;
    });
  }
  function lensSince(from, why, go) {
    if (!CONFIG.served) return;
    fetchSince(from).then(() => { state.lens = { kind: 'since', from, why }; lensMemo = null; navAt = null; if (go) lensGo(); else render(); }, (e) => toast(`Can’t show what changed since ${shortSha(from)}: ${e.message}`));
  }
  // The first chain (or the changes outside chains) with something in the lens to review.
  function lensGo() {
    const nx = nextUnreviewed();
    if (!nx) { render(); return toast('Nothing left to review in the lens'); }
    state.view = nx; state.peek = null; state.focus = null;
    toChains();
    render({ top: true });
  }
  // What the graph learns from untangle: your last review's head, GitHub's checks, reviews and
  // force pushes. Asked when the page opens and again when the graph shows, at most once a minute.
  function loadCommits(force) {
    if (!hxOn() || !CONFIG.served) return;
    if (HX.loading || (!force && HX.liveAt && Date.now() - HX.liveAt < 60000)) return;
    HX.loading = api('history').then((r) => r.json()).then((j) => {
      if (j.error) throw new Error(j.error);
      HX.live = j;
      HX.liveAt = Date.now();
      if (j.review && j.review.here) return fetchSince(j.review.head).catch(() => {});
    }).catch(() => { HX.liveAt = Date.now(); }).then(() => { HX.loading = null; render(); });
  }

  // ---------- sidebar
  // The lines a row's changes add and remove, in place of its count while it's hovered. Drawn from
  // its attributes, so the row's text stays its name and its count.
  const sideDiff = (a, d) => (a > 0 || d > 0 ? `<span class="df"${a > 0 ? ` data-a="+${fmt(a)}"` : ''}${d > 0 ? ` data-d="−${fmt(d)}"` : ''} aria-hidden="true"></span>` : '');
  const filesDiff = (files) => sideDiff(files.reduce((x, f) => x + Math.max(0, f.a || 0), 0), files.reduce((x, f) => x + Math.max(0, f.d || 0), 0));
  // A commit's lines added and removed, from its files (a binary file's count none).
  const commitDiff = (c) => c.df != null ? c.df : (c.df = sideDiff(...(c.files || []).reduce((x, [, , a, d]) => (a < 0 ? x : [x[0] + a, x[1] + d]), [0, 0])));
  // A row's mark: amber while it has changes to review, a check once they're all reviewed.
  const markHtml = (st) => (st.open ? '<i class="mk"></i>' : outOfLens(st) ? '<i class="mk out"></i>' : `<i class="mk ok">${ICON.check}</i>`);
  function renderSide() {
    const m = M();
    const all = m.files.flatMap((f) => f.blocks);
    const t = stats(all);
    const pct = t.all ? Math.round((1 - t.lines / t.all) * 100) : 100;
    const v = state.view;
    const tab = (k, label, n) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${state.tab === k}">${label}<i>${n}</i></button>`;
    // The Threads tab: GitHub's open threads and the open notes.
    const threadsOn = GH.on || NT.on;
    const openNotes = NT.data ? NT.data.notes.filter((x) => !x.resolved).length : 0;
    const openThreads = GH.on && !GH.data && !GH.error ? '…' : (GH.data ? GH.data.threads.filter((x) => !x.resolved).length : 0) + openNotes;
    let h = `<div class="sb-top">${compact() ? `<div class="sb-pr">${prHtml(true)}</div>` : ''}<div class="sb-prog${t.open ? '' : ' all'}" title="${pct}% of the changed lines reviewed: ${t.total - t.open} of ${t.total} changes">`
      + (t.open ? `<b>${t.open}</b><span>change${t.open === 1 ? '' : 's'} to review</span>` : `<b>${ICON.check}</b><span>All ${t.total} changes reviewed</span>`)
      + `<button type="button" class="ib" data-act="menu" data-menu="side" title="Where your marks are kept" aria-label="Marks" aria-haspopup="dialog" aria-expanded="${MENU.open === 'side'}">${ICON.more}</button><div class="sb-bar" aria-hidden="true"><i style="width:${pct}%"></i></div></div>`
      // Four tabs fit the sidebar without their counts: they show when it's wider.
      + `<div class="sb-tabs${threadsOn && hxOn() ? ' four' : ''}" role="tablist">${tab('chains', 'Chains', m.chains.length)}${tab('files', 'Files', m.files.length)}${threadsOn ? tab('comments', 'Threads', openThreads) : ''}${hxOn() ? tab('commits', 'Commits', HISTORY.commits.length) : ''}</div></div>`;
    // Rows that stay at the top with the tabs, over a line: the views beside the list.
    let pin = '';
    const top = h;
    h = '';
    if (state.tab === 'commits' && hxOn()) {
      const ct = commitsTabHtml();
      pin = ct.pin;
      h += ct.list;
    } else if (state.tab === 'comments') {
      h += commentsTabHtml(v);
    } else if (state.tab === 'chains' || state.tab === 'commits') {
      // `next`: the depth of the row after it, for its guides.
      const row = (c, depth, next) => {
        const st = stats(blocksOf(c.blocks));
        const on = v.kind === 'chain' && v.id === c.id;
        const n = splitName(c.name), d = Math.min(depth, 6);
        return `<button type="button" class="sb-row chain${st.open ? '' : ' done'}${outOfLens(st) ? ' lens-out' : ''}" data-chain="${c.id}"${on ? ' aria-current="true"' : ''} style="--d:${d}" title="${esc(c.name)}: ${leftWords(st)} · ${c.files} file${c.files > 1 ? 's' : ''} · +${fmt(c.adds)} −${fmt(c.dels)}">${guides(d, Math.min(next, 6))}${markHtml(st)}<span class="nm${proseName(c) ? ' ui' : ''}">${n.own ? `<span class="own">${esc(n.own)}</span>` : ''}${esc(n.name)}</span>${sideDiff(c.adds, c.dels)}<span class="cnt">${st.open || ''}</span></button>`;
      };
      const linked = m.byCommit ? m.families : m.families.filter((f) => f.chains.length > 1);
      const lone = m.byCommit ? [] : m.families.filter((f) => f.chains.length === 1).map((f) => f.chains[0]).sort((x, y) => y.blocks.length - x.blocks.length);
      pin += `<button type="button" class="sb-row map" data-map="${linked.length ? linked[0].id : ''}"${v.kind === 'map' ? ' aria-current="true"' : ''} title="${m.byCommit ? 'The commits’ chains, and which builds on which' : `${linked.length} famil${linked.length === 1 ? 'y' : 'ies'} of linked chains, in levels`}"><span class="tw">${ICON.map}</span><span class="nm ui">Chain map</span><span class="cnt"></span></button>`;
      if (hxOn()) pin += `<button type="button" class="sb-row map" data-act="history-open"${v.kind === 'history' ? ' aria-current="true"' : ''} title="The commits: each one, what it touched, its checks and reviews"><span class="tw">${ICON.history}</span><span class="nm ui">History</span><span class="cnt">${HISTORY.commits.length}</span></button>`;
      const tt = testsTotals();
      if (tt.outlined) pin += `<button type="button" class="sb-row map" data-act="tests-open"${v.kind === 'tests' ? ' aria-current="true"' : ''} title="The sentences the tests add, reword, regroup or remove, on one page"><span class="tw">${ICON.tests}</span><span class="nm ui">Tests</span><span class="cnt">${tt.all || ''}</span></button>`;
      if (m.byCommit) {
        // A commit's chain is one row, in the order the commits were made; renames come last.
        h += m.families.filter((f) => !f.same).map((f) => row(f.chains[0], 0, 0)).join('');
        m.families.filter((f) => f.same).forEach((f) => { h += '<div class="sb-group"><span title="A name swapped for another in several places, apart from the commits’ chains">Renamed in several places</span></div>' + f.chains.map((c) => row(c, 0, 0)).join(''); });
      }
      linked.forEach((f) => { if (m.byCommit) return; h += `<div class="sb-group"><span title="${esc(f.top.name)}">The ${esc(trunc(f.top.name, 34))} family</span></div>` + f.chains.map((c, k) => row(c, c.depth, k + 1 < f.chains.length ? f.chains[k + 1].depth : -1)).join(''); });
      if (lone.length) h += '<div class="sb-group"><span>Unlinked</span></div>' + lone.map((c) => row(c, 0, 0)).join('');
      const st = stats(m.standalone);
      if (st.total) h += `<div class="sb-group"><span>Outside chains</span></div><button type="button" class="sb-row chain${st.open ? '' : ' done'}" data-standalone="1"${v.kind === 'standalone' ? ' aria-current="true"' : ''} title="Changes that don’t use, and aren’t used by, anything changed elsewhere: ${leftWords(st)}">${markHtml(st)}<span class="nm ui">Not in a chain</span>${sideDiff(sumOf(m.standalone, 'adds'), sumOf(m.standalone, 'dels'))}<span class="cnt">${st.open || ''}</span></button>`;
    } else {
      const on = (f) => (v.kind === 'file' && v.path === f.p ? ' aria-current="true"' : '');
      // A chain open: the files it has no changes in fade, as its commits do in the Commits tab.
      const chainOn = v.kind === 'chain' && m.chains[v.id];
      const mine = chainOn ? new Set(chainOn.blocks.map((id) => m.blockById.get(id).file.p)) : null;
      const out = (files) => !!mine && !files.some((f) => mine.has(f.p));
      const outCls = (files) => (out(files) ? ' chain-out' : '');
      const outWords = (f) => (out([f]) ? '. None of its changes are in the open chain' : '');
      // A file the changes add, or delete, says so in its color, as in a diff.
      const status = (f) => ' s-' + f.s.toLowerCase();
      const statusWords = (f) => (f.s === 'A' ? 'added, ' : f.s === 'D' ? 'deleted, ' : '');
      // What the review covers, in lines: the generated files and migrations below aren't in it.
      if (m.files.length) h += `<div class="sb-group" title="The lines the review’s files add and remove. Generated files and migrations, below, aren’t reviewed or counted."><span>In the review</span><span>${plural(m.files.length, 'file')} · ${plusMinus(sumOf(m.files, 'a'), sumOf(m.files, 'd'))}</span></div>`;
      h += treeHtml(fileTree(m.files), 0, {
        prefix: '',
        count: (files) => { const st = stats(files.flatMap((f) => f.blocks)); return { text: st.open || '', done: !st.open, diff: filesDiff(files), cls: outCls(files) }; },
        file: (f, depth, g) => {
          const st = stats(f.blocks);
          return `<button type="button" class="sb-row tr${status(f)}${st.open ? '' : ' done'}${outCls([f])}" data-open="${esc(f.p)}"${on(f)} style="--d:${depth}" title="${esc(f.p)}: ${statusWords(f)}${leftWords(st)}${outWords(f)}">${g}${markHtml(st)}<span class="nm">${esc(fileName(f.p))}</span>${filesDiff([f])}<span class="cnt">${openThreadsHtml(f.p)}${st.open || ''}</span></button>`;
        },
      });
      const migration = (f) => /(^|\/)migrations?\//i.test(f.p);
      for (const [key, label, files] of [
        ['generated', 'Generated', m.generated.filter((f) => !migration(f))],
        ['migrations', 'Migrations', m.generated.filter(migration)],
      ]) {
        if (!files.length) continue;
        const open = state.fileSections.has(key);
        h += `<button type="button" class="sb-group" data-act="file-section" data-section="${key}" aria-expanded="${open}" aria-controls="files-${key}"><span>${label}, not reviewed</span><span>${files.length} · ${open ? 'Collapse' : 'Expand'}</span></button>`;
        h += `<div id="files-${key}"${open ? '' : ' hidden'}>`;
        if (open) h += treeHtml(fileTree(files), 0, {
          prefix: key + ':',
          count: (files) => ({ text: '', done: false, diff: filesDiff(files), cls: outCls(files) }),
          file: (f, depth, g) => `<button type="button" class="sb-row tr gen${status(f)}${outCls([f])}" data-open="${esc(f.p)}"${on(f)} style="--d:${depth}" title="${esc(f.p)}: ${statusWords(f)}${key} (${esc(f.gen)})${outWords(f)}">${g}<i class="mk gen"></i><span class="nm">${esc(fileName(f.p))}</span>${filesDiff([f])}<span class="cnt">+${fmt(f.a)}</span></button>`,
        });
        h += '</div>';
      }
    }
    h = (pin ? top.replace(/<\/div>$/, `<div class="sb-pin">${pin}</div></div>`) : top) + h;
    // Most clicks change only the code: the sidebar stays as it is.
    if (h === sideHtml) return;
    const before = moving() ? sideRows() : null;
    side.innerHTML = h;
    sideHtml = h;
    if (before) sideMotion(before);
  }
  // Whether the pointer is on an element (a row drawn under a still pointer isn't :hover yet).
  let pointerAt = null;
  document.addEventListener('pointermove', (e) => { pointerAt = [e.clientX, e.clientY]; }, { passive: true, capture: true });
  document.addEventListener('pointerdown', (e) => { pointerAt = [e.clientX, e.clientY]; }, { passive: true, capture: true });
  const under = (el) => { if (!pointerAt) return false; const r = el.getBoundingClientRect(); return pointerAt[0] >= r.left && pointerAt[0] < r.right && pointerAt[1] >= r.top && pointerAt[1] < r.bottom; };
  // The sidebar's rows by what they open, for the motion between two drawings of it.
  const sideKey = (r) => { const d = r.dataset; return d.chain != null ? 'c' + d.chain : d.open != null ? 'f' + d.open : d.standalone ? 's' : d.thread ? 't' + d.thread : d.map != null ? 'map' : d.dir != null ? 'd' + d.dir : d.act || ''; };
  function sideRows() {
    const out = new Map();
    side.querySelectorAll('.sb-row').forEach((r) => out.set(sideKey(r), { done: r.classList.contains('done'), cur: r.getAttribute('aria-current') === 'true', top: r.offsetTop, pin: !!r.closest('.sb-pin'), cnt: (r.querySelector('.cnt') || {}).textContent, faded: r.classList.contains('chain-out'), held: !!r.querySelector('.cnt > .mk') }));
    side.querySelectorAll('.cm-row[data-commit]').forEach((r) => out.set('k' + r.dataset.commit, { fade: getComputedStyle(r).opacity }));
    return out;
  }
  // A row done since: its count gives way to a check and it dims. A count that changed rolls. The
  // highlight slides from the row that was open to the one that is, unless the pointer is on that
  // row already (it was clicked: the hover went there first).
  function sideMotion(before) {
    let from = null;
    before.forEach((v) => { if (v.cur) from = v; });
    // A commit that the chain open now has, or no longer has, eases to its new weight.
    side.querySelectorAll('.cm-row[data-commit]').forEach((r) => {
      const v = before.get('k' + r.dataset.commit), now = getComputedStyle(r).opacity;
      if (v && v.fade !== now) r.animate([{ opacity: v.fade }, { opacity: now }], { duration: 200, easing: EASE });
    });
    side.querySelectorAll('.sb-row').forEach((r) => {
      const v = before.get(sideKey(r));
      if (!v) return;
      // So does a file in the Files tab (not the tree's lines).
      const faded = r.classList.contains('chain-out');
      if (faded !== v.faded) [...r.children].forEach((x) => { if (!x.matches('.ig')) x.animate([{ opacity: v.faded ? 0.38 : 1 }, { opacity: faded ? 0.38 : 1 }], { duration: 200, easing: EASE }); });
      if (r.classList.contains('done') && !v.done) {
        const mk = r.querySelector('.mk');
        if (mk) mk.animate([{ transform: 'scale(.3)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 200, easing: EASE });
        // A file the changes add, or delete, keeps its hue.
        const nm = r.querySelector('.nm'), ink = r.classList.contains('s-a') ? ['add-ink', 'add-no'] : r.classList.contains('s-d') ? ['del-ink', 'del-no'] : ['text', 'text-3'];
        if (nm) nm.animate([{ color: `var(--${ink[0]})` }, { color: `var(--${ink[1]})` }], { duration: 200, easing: EASE });
      }
      // A folder just closed takes the mark of what's left to review inside it.
      const held = r.querySelector('.cnt > .mk');
      if (held && !v.held) held.animate([{ transform: 'scale(.3)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 200, easing: EASE });
      const cnt = r.querySelector('.cnt');
      if (cnt && v.cnt !== cnt.textContent && /^\d*$/.test(v.cnt || '') && /^\d*$/.test(cnt.textContent)) cnt.animate([{ transform: 'translateY(-5px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 200, easing: EASE });
      if (r.getAttribute('aria-current') === 'true' && from && !v.cur && !under(r) && !from.pin && !v.pin && Math.abs(r.offsetTop - from.top) < 600) {
        const hl = document.createElement('div');
        hl.className = 'sb-hl';
        hl.style.cssText = `top:${r.offsetTop}px;left:${r.offsetLeft}px;width:${r.offsetWidth}px;height:${r.offsetHeight}px`;
        side.appendChild(hl);
        r.classList.add('sliding');
        const end = () => { hl.remove(); r.classList.remove('sliding'); };
        hl.animate([{ transform: `translateY(${from.top - r.offsetTop}px)` }, { transform: 'none' }], { duration: 200, easing: EASE }).finished.then(end, end);
      }
    });
  }
  let sideHtml = '';
  // Hovering a commit, in the Commits tab or in a chain's bar, dims the lines it didn't write (a
  // rule on the rows' data-w, so no row is touched) and lights the commit in both places.
  const litStyle = document.createElement('style');
  document.head.appendChild(litStyle);
  let litNow = null, litNext = null, litRaf = 0;
  function lightCommit(ci) {
    litNext = ci;
    if (litRaf) return;
    litRaf = requestAnimationFrame(() => {
      litRaf = 0;
      if (litNext !== litNow) {
        litNow = litNext;
        litStyle.textContent = litNow == null ? '' : `.vw-main .ln:not([data-w="${litNow}"]) > :not(.g), .vw-main .half:not([data-w="${litNow}"]) { opacity: .3; }`;
        viewer.classList.toggle('w-lit', litNow != null);
      }
      viewer.querySelectorAll('.wb-seg.hl, .cm-row.hl').forEach((el) => el.classList.remove('hl'));
      if (litNow != null) viewer.querySelectorAll(`.wb-seg[data-ci="${litNow}"], .cm-row[data-ci="${litNow}"]`).forEach((el) => el.classList.add('hl'));
    });
  }
  side.addEventListener('mouseover', (e) => { const r = e.target.closest('.cm-row[data-ci]'); lightCommit(r ? Number(r.dataset.ci) : null); });
  side.addEventListener('mouseleave', () => lightCommit(null));
  main.addEventListener('mouseover', (e) => { const sg = e.target.closest('.wb-seg[data-ci]'); lightCommit(sg ? Number(sg.dataset.ci) : null); });
  main.addEventListener('mouseleave', () => lightCommit(null));
  // The Files tab: folders first, then files, by name. A folder that holds only a folder shows
  // with it ("lib/src/mcp"), as VS Code compacts them; lines mark the levels.
  function fileTree(files) {
    const root = { dirs: new Map(), files: [] };
    files.forEach((f) => {
      const parts = f.p.split('/');
      let node = root;
      parts.slice(0, -1).forEach((name, i) => {
        if (!node.dirs.has(name)) node.dirs.set(name, { name, path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] });
        node = node.dirs.get(name);
      });
      node.files.push(f);
    });
    return root;
  }
  const byName = (x, y) => x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });
  const filesIn = (d) => d.files.concat(...[...d.dirs.values()].map(filesIn));
  // The lines that mark a row's levels. A level's line ends on the last row it holds (when the
  // next row, at depth `next`, is back at that level or above), turning toward the row (└).
  const guides = (depth, next) => Array.from({ length: depth }, (_, i) => `<i class="ig${next != null && next <= i ? (i === depth - 1 ? ' end elbow' : ' end') : ''}" style="left:${14 + i * 14}px"></i>`).join('');
  function treeRowsHtml(rows) {
    const following = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      while (following.length && following.at(-1).depth > row.depth) following.pop();
      row.last = !following.length || following.at(-1).depth < row.depth;
      following.push(row);
    }

    const continuing = [];
    return rows.map((row) => {
      continuing.length = row.depth;
      if (row.depth) continuing[row.depth - 1] = !row.last;
      const lines = continuing.map((more, level) => {
        const own = level === row.depth - 1;
        if (!own && !more) return '';
        return `<i class="ig${own && row.last ? ' end elbow' : ''}" style="left:${14 + level * 14}px"></i>`;
      }).join('');
      return row.html(lines);
    }).join('');
  }
  // A tree's rows, as drawn, each knowing the depth of the row after it for its guides.
  function treeHtml(node, depth, o) {
    const rows = [];
    const walk = (nd, dp) => {
      [...nd.dirs.values()].sort((x, y) => byName(x.name, y.name)).forEach((d) => {
        let name = d.name;
        while (d.dirs.size === 1 && !d.files.length) { d = [...d.dirs.values()][0]; name += '/' + d.name; }
        const key = o.prefix + d.path, open = !state.closedDirs.has(key), c = o.count(filesIn(d));
        // Closed, a folder keeps the mark of the changes to review inside it, by their count.
        const held = !open && !c.done && c.text;
        rows.push({ depth: dp, html: (g) => `<button type="button" class="sb-row tr dir${c.done ? ' done' : ''}${c.cls || ''}" data-dir="${esc(key)}" aria-expanded="${open}" style="--d:${dp}" title="${esc(d.path)}/${held ? `: ${plural(c.text, 'change')} to review inside` : ''}">${g}<span class="tw">${open ? ICON.chevronDown : ICON.chevronRight}</span><span class="nm">${esc(name)}</span>${c.diff || ''}<span class="cnt">${held ? '<i class="mk"></i>' : ''}${c.text}</span></button>` });
        if (open) walk(d, dp + 1);
      });
      nd.files.slice().sort((x, y) => byName(fileName(x.p), fileName(y.p))).forEach((f) => rows.push({ depth: dp, html: (g) => o.file(f, dp, g) }));
    };
    walk(node, depth);
    return treeRowsHtml(rows);
  }

  // ---------- motion: what changes moves from where it was to where it goes, fast enough not to
  // wait for (120 to 280 ms, easing out). A reviewed hunk folds into its divider while the code
  // below glides up; lines shown from a divider open downward from it; a peek, or a commit's
  // details, grows from where it was asked and folds back there when it closes; going to a change
  // scrolls there and pulses it, and landing further down glides over the last stretch. With
  // "reduce motion" set, all of it is instant.
  const REDUCE = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const moving = () => !REDUCE.matches && typeof Element.prototype.animate === 'function';
  // The lines a refresh's new commits changed, while they glow. The renders that follow the reload
  // (the highlighter's, GitHub's) draw the code anew: each draws them glowing again, from where
  // the glow had got to.
  const GLOW_MS = 1800;
  let glow = null;
  function glowRows() {
    if (!glow) return;
    const t = Date.now() - glow.at;
    if (t > GLOW_MS) { glow = null; return; }
    main.querySelectorAll('.code[data-p]').forEach((code) => {
      const ranges = glow.files[code.dataset.p];
      if (ranges) code.querySelectorAll('[data-n]').forEach((row) => { const n = Number(row.dataset.n); if (n && ranges.some(([a, b]) => n >= a && n <= b)) { row.classList.add('glow'); row.style.animationDelay = `-${t}ms`; } });
    });
  }
  const EASE = 'cubic-bezier(.2, 0, 0, 1)';
  const easeOut = (p) => 1 - Math.pow(1 - p, 4);
  // A menu, or Review's, opens from its button (its transform-origin), growing as it fades in,
  // and closes back into it: the same motion, reversed. Turned around midway, it goes back from
  // where it is. `closed` runs once it's out of sight.
  const POP_FRAMES = [{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }];
  const POP_MS = 150;
  const popping = new WeakMap();
  function pop(el, open, closed) {
    // Swiped down, it closes out of sight, where the finger sent it; opened again meanwhile, it's back.
    const away = sliding.get(el);
    if (away && !open) {
      unpop(el);
      away.finished.then(() => { if (sliding.get(el) !== away) return; sliding.delete(el); closed(); away.cancel(); }, () => {});
      return;
    }
    if (away) { sliding.delete(el); away.cancel(); }
    let a = popping.get(el);
    if (!moving()) { unpop(el); if (!open) closed(); return; }
    if (!a) {
      a = el.animate(POP_FRAMES, { duration: POP_MS, easing: EASE, fill: 'both' });
      popping.set(el, a);
      // Open without motion so far: it closes from open.
      if (!open) a.finish();
    }
    a.onfinish = () => {
      if (popping.get(el) !== a) return;
      popping.delete(el);
      a.cancel();
      if (a.playbackRate < 0) closed();
    };
    a.playbackRate = open ? 1 : -1;
    a.play();
  }
  function unpop(el) { const a = popping.get(el); if (a) { popping.delete(el); a.cancel(); } }
  // What the next render is for: { mark: [block ids] } (changes marked or unmarked, sections
  // folded), { more: { key, side, n } } (lines shown from a divider), or { away: { act, p } } (a
  // file's threads or notes off its diff, folded or unfolded).
  let motionNext = null;
  const hint = (h) => { motionNext = h; };
  const viewKey = () => { const v = state.view; return [v.kind, v.id, v.path, v.family, v.side, v.ext, state.compare].join('|'); };
  // A section's rows: what follows its divider, up to the next divider or the end of its code.
  function regionOf(band) {
    const out = [];
    for (let el = nextIn(band); el && !el.matches('.hh'); el = nextIn(el)) out.push(el);
    return out;
  }
  const bandByKey = (key) => [...main.querySelectorAll('.hh[data-sec]')].find((b) => b.dataset.sec === key) || null;
  const regionBottom = (band, rows) => (rows.length ? rows[rows.length - 1].getBoundingClientRect().bottom : band.getBoundingClientRect().bottom);
  // The same row in the page drawn again: same file, same line.
  function sameRow(old) {
    const n = old && old.dataset && old.dataset.n;
    if (!n) return null;
    const code = old.closest('.code[data-p]'), p = code ? code.dataset.p : null;
    return [...main.querySelectorAll(`[data-n="${n}"]`)].find((r) => { const c = r.closest('.code[data-p]'); return !p || (c && c.dataset.p === p); }) || null;
  }
  // Where an element sat, to find it again in the page drawn anew: the same row (file and line),
  // else the same place under the nearest part of the page with an id or a commit's details.
  function placeOf(el) {
    if (!el) return () => null;
    if (el.dataset && el.dataset.n) return () => sameRow(el);
    const path = [];
    let at = el;
    while (at && at !== main && !at.id && !(at.dataset && at.dataset.detailOf)) { path.unshift([...at.parentElement.children].indexOf(at)); at = at.parentElement; }
    if (!at) return () => null;
    const root = at === main ? null : at.id ? '#' + CSS.escape(at.id) : `[data-detail-of="${CSS.escape(at.dataset.detailOf)}"]`;
    return () => { let x = root ? main.querySelector(root) : main; for (const i of path) x = x && x.children[i]; return x || null; };
  }
  // An element's height with its vertical margins: the gap it leaves when it goes.
  const gapOf = (el) => { const cs = getComputedStyle(el); return el.getBoundingClientRect().height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom); };
  // Before a render: where what may move is.
  function motionBefore() {
    const h = motionNext;
    motionNext = null;
    if (!moving()) return null;
    // Another view (the state names it already): nothing on screen moves into it.
    if (GD.view !== viewKey()) return null;
    const box = main.getBoundingClientRect();
    const seen = (top, bottom) => bottom > box.top && top < box.bottom;
    const snap = { hint: h, view: viewKey(), peek: null, detail: null, threads: new Map(), sections: [] };
    if (h && h.mark) {
      main.querySelectorAll('.hh[data-sec]').forEach((band) => {
        const rows = regionOf(band), top = band.getBoundingClientRect().bottom, bottom = regionBottom(band, rows);
        if (seen(top, bottom)) snap.sections.push({ key: band.dataset.sec, h: bottom - top, rows });
      });
    }
    const pk = main.querySelector(PEEK);
    if (pk) {
      const r = pk.getBoundingClientRect(), code = pk.querySelector('.pk-code');
      if (seen(r.top, r.bottom)) snap.peek = { el: pk, place: placeOf(pk.previousElementSibling), h: r.height, gap: gapOf(pk), anchor: peekKey(shownPeek), scroll: code ? [code.scrollLeft, code.scrollTop] : null };
    }
    const dt = main.querySelector('.hs-detail');
    if (dt) { const r = dt.getBoundingClientRect(); if (seen(r.top, r.bottom)) snap.detail = { el: dt, sha: dt.dataset.detailOf, gap: gapOf(dt), place: placeOf(dt.previousElementSibling) }; }
    main.querySelectorAll('.th[data-thread], .th[data-note]').forEach((t) => { const r = t.getBoundingClientRect(); if (seen(r.top, r.bottom)) snap.threads.set(thKey(t), { h: r.height, el: t }); });
    const away = h && h.away && awayBtn(h.away);
    if (away) snap.away = { key: h.away, items: awayOf(away), h: away.parentElement.getBoundingClientRect().height };
    if (h && h.ol != null) snap.ol = olSnap(h);
    else if (h && h.olf != null) snap.ol = olSnapFile(h.olf, !!h.mark);
    return snap;
  }
  // An outline's pieces, keyed so two drawings of it line up: its rows by call, a row's code by its
  // row, a fold by what it folds, a file by its path, anything else by what's above it.
  function olItems(box) {
    const out = [];
    let row = '', anchor = '', k = 0;
    for (const el of box.children) {
      let key;
      if (el.matches('.ol-row[data-ol]')) key = 'r' + (row = el.dataset.ol);
      else if (el.matches('.ol-file')) key = 'h';
      else if (el.matches('.ol-code')) key = 'c' + row;
      else if (el.matches('[data-act="ol-unfold"]')) key = 'f' + el.dataset.key;
      else if (el.matches('.ol-sec[data-olf]')) key = 's' + el.dataset.olf;
      else { out.push({ k: anchor + '|' + el.className + '|' + k++, el }); continue; }
      out.push({ k: key, el });
      anchor = key;
      k = 0;
    }
    return out;
  }
  // What a click on an outline is about to open or fold: the pieces of the part it's in, and where
  // they are.
  function olSnap(h) {
    const el = [...main.querySelectorAll(h.fold ? '[data-act="ol-unfold"]' : '.ol-row[data-ol]')].find((x) => (h.fold ? x.dataset.key : x.dataset.ol) === h.ol);
    const box = el && el.parentElement;
    if (!box || !(box === main || box.matches('.ol-sec[data-olf]'))) return null;
    return olMeasure(box, false);
  }
  // A test file's outline, as marking it (settle: what's marked folds away) or folding it changes it.
  function olSnapFile(path, settle) {
    const box = [...main.querySelectorAll('.ol-sec[data-olf]')].find((x) => x.dataset.olf === path);
    return box ? olMeasure(box, settle) : null;
  }
  const olMeasure = (box, settle) => ({ box: box === main ? null : box.dataset.olf, settle, items: olItems(box).map((x) => ({ ...x, r: x.el.getBoundingClientRect(), mb: parseFloat(getComputedStyle(x.el).marginBottom) || 0 })) });
  // The same part drawn again: what's gone folds back into what's above it, while what's new opens
  // downward from it. What took the place of what's gone (a line of reviewed rows) opens as that
  // closes under it; marked rows first settle as reviewed.
  function olMotion(o) {
    const box = o.box == null ? main : [...main.querySelectorAll('.ol-sec[data-olf]')].find((x) => x.dataset.olf === o.box);
    if (!box) return;
    const now = olItems(box), has = new Map(now.map((x) => [x.k, x.el])), had = new Set(o.items.map((x) => x.k));
    const fresh = new Set(now.filter((x) => !had.has(x.k)).map((x) => x.el));
    const gone = [];
    let run = [], prev = null;
    const close = (next) => {
      const a = prev && has.get(prev.k);
      if (run.length && a) {
        const b = next && has.get(next.k), last = run[run.length - 1];
        const was = next ? next.r.top - prev.r.bottom : last.r.bottom + last.mb - prev.r.bottom;
        // What's new in the same place opens from nothing: it doesn't count yet.
        let at = a, added = 0;
        for (let el = a.nextElementSibling; el && el !== b; el = el.nextElementSibling) if (fresh.has(el)) { added += gapOf(el); at = el; }
        const is = (b ? b.getBoundingClientRect().top - a.getBoundingClientRect().bottom : parseFloat(getComputedStyle(a).marginBottom) || 0) - added;
        if (was - is > 3) gone.push({ a: at, h: was - is, els: run.map((x) => x.el) });
      }
      run = [];
    };
    for (const x of o.items) { if (has.has(x.k)) { close(x); prev = x; } else run.push(x); }
    close(null);
    const wait = o.settle ? 160 : 0;
    gone.forEach((g) => {
      const ghost = closeGap(g.a, g.h, g.els, wait);
      if (!o.settle) { ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: EASE, fill: 'forwards' }); return; }
      ghost.querySelectorAll('.tick:not(.on)').forEach((t) => { t.classList.remove('part'); t.classList.add('on'); popTick(t); });
      requestAnimationFrame(() => ghost.classList.add('settle'));
    });
    let grow = [];
    for (const x of now) { if (had.has(x.k)) { growRows(grow, 0, wait); grow = []; } else grow.push(x.el); }
    growRows(grow, 0, wait);
  }
  // While the page's own motion opens or closes something, the browser doesn't move the page to
  // keep what's below it in place. It anchors on what isn't sticky, and an outline's rows and a
  // test's code are (they stay put as the pane scrolls sideways): opening a test with its row half
  // under the header, the page would follow the code past it, and jump by the test's height.
  let unanchoring = 0;
  function unanchored(a) {
    if (!unanchoring++) main.style.overflowAnchor = 'none';
    const back = () => { if (!--unanchoring) main.style.overflowAnchor = ''; };
    a.finished.then(back, back);
    return a;
  }
  // A gap that closes: the space something left, shrinking to nothing (with what was there, fading).
  function closeGap(after, h, content, delay) {
    const ghost = document.createElement('div');
    ghost.className = 'ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    ghost.style.height = h + 'px';
    if (content) {
      // What the page kept (drawn again in place) stays where it is.
      content.forEach((el) => { if (!el.isConnected) ghost.appendChild(el); });
      // What's in it is a picture: nothing in it is found or pressed.
      const attrs = ['id', 'data-block', 'data-sec', 'data-n', 'data-c', 'data-thread', 'data-note', 'data-comment', 'data-draft', 'data-act', 'data-nav', 'data-mark', 'data-ol', 'data-key', 'data-olf', 'data-open', 'data-blocks'];
      ghost.querySelectorAll(attrs.map((a) => `[${a}]`).join(', ')).forEach((el) => attrs.forEach((a) => el.removeAttribute(a)));
    }
    after.after(ghost);
    const done = () => { ghost.remove(); mini.update(); };
    unanchored(ghost.animate([{ height: h + 'px' }, { height: '0px' }], { duration: 280, delay: delay || 0, easing: EASE, fill: 'backwards' })).finished.then(done, done);
    return ghost;
  }
  // Code new to the page paints its rows a frame late (they skip painting off screen, see .code), so
  // it fades in, once it's there. A test's code and anything else show as their space opens.
  const late = (el) => (el.matches('.code, .ln, .sl') && !el.closest('.ol-code')) || !!el.querySelector('.code:not(.ol-code)');
  // Rows that just appeared open downward from what's above them.
  function growRows(rows, fromH, delay) {
    if (!rows.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'grow';
    rows[0].before(wrap);
    rows.forEach((el) => wrap.appendChild(el));
    const h = wrap.getBoundingClientRect().height;
    if (h - (fromH || 0) < 3) { wrap.replaceWith(...wrap.childNodes); return; }
    const unwrap = () => { if (wrap.isConnected) wrap.replaceWith(...wrap.childNodes); mini.update(); };
    unanchored(wrap.animate([{ height: (fromH || 0) + 'px' }, { height: h + 'px' }], { duration: 280, delay: delay || 0, easing: EASE, fill: 'backwards' })).finished.then(unwrap, unwrap);
    if (!fromH && rows.some(late)) wrap.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 80 + (delay || 0), easing: EASE, fill: 'backwards' });
  }
  const popTick = (t) => t.animate([{ backgroundColor: '#58C597', transform: 'scale(1.2)' }, { backgroundColor: 'rgba(88, 197, 151, 0)', transform: 'scale(1)' }], { duration: 420, easing: EASE });
  // A section after its changes were marked: folded (its old rows settle as reviewed, then fold into
  // its divider), shorter (the gap closes under it), or longer (its rows open downward).
  function sectionMotion(s) {
    const band = bandByKey(s.key);
    if (!band) return;
    const rows = regionOf(band);
    const dh = s.h - (regionBottom(band, rows) - band.getBoundingClientRect().bottom);
    if (dh > 3 && !rows.length) {
      const ghost = closeGap(band, dh, s.rows, 160);
      ghost.querySelectorAll('.tick').forEach((t) => { t.classList.add('on'); popTick(t); });
      requestAnimationFrame(() => ghost.classList.add('settle'));
    } else if (dh > 3) closeGap(rows[rows.length - 1], dh, null, 40);
    else if (dh < -3) growRows(rows, s.h);
  }
  // What a row's "more" showed: n rows under the divider (above a section), or just before the
  // divider that follows the section (below it).
  function moreMotion(m) {
    const band = bandByKey(m.key);
    if (!band) return;
    const take = (from, next) => {
      const out = [];
      for (let el = next ? nextIn(from) : prevIn(from), k = 0; el && !el.matches('.hh') && k < m.n; el = next ? nextIn(el) : prevIn(el)) { if (el.matches('.ln, .sl')) k++; out.push(el); }
      return next ? out : out.reverse();
    };
    if (m.side === 'above') return growRows(take(band, true));
    const rows = regionOf(band), after = rows.length ? nextIn(rows[rows.length - 1]) : nextIn(band);
    growRows(after ? take(after, false) : rows.slice(-m.n));
  }
  let shownPeek = null, clickX = null;
  document.addEventListener('pointerdown', (e) => { clickX = e.clientX; }, true);
  // Where a peek is: under which line.
  const peekKey = (p) => (p ? JSON.stringify([p.path, p.n, !!p.old, p.o, p.src ? p.src.key + ':' + p.src.line : null, p.ext ? [p.ext.chain, p.ext.anchor, p.ext.i] : null, p.moveOf || null]) : '');
  // A peek grows from the name it was asked from, and folds back into its line when it closes. One
  // that stays where it is with other content (an answer, another definition, Back) eases to its
  // new height.
  function peekMotion(snap) {
    const el = main.querySelector(PEEK);
    if (state.peek && el && snap.peek && snap.peek.anchor === peekKey(state.peek)) {
      const h = el.getBoundingClientRect().height;
      if (Math.abs(h - snap.peek.h) > 3) unanchored(el.animate([{ height: snap.peek.h + 'px' }, { height: h + 'px' }], { duration: 200, easing: EASE }));
    } else if (state.peek && el && state.peek !== shownPeek) {
      const r = el.getBoundingClientRect();
      if (clickX != null) el.style.transformOrigin = `${Math.max(0, Math.min(r.width, clickX - r.left))}px 0`;
      unanchored(el.animate([{ height: '0px', opacity: 0, transform: 'scale(.97) translateY(-4px)' }, { height: r.height + 'px', opacity: 1, transform: 'none' }], { duration: 200, easing: EASE }));
    } else if (!state.peek && snap.peek) {
      const at = snap.peek.place();
      if (at) {
        const g = closeGap(at, snap.peek.gap, [snap.peek.el]);
        // Moved into the closing gap, its code would start over at its top: it stays where it was.
        const code = g.querySelector('.pk-code');
        if (code && snap.peek.scroll) [code.scrollLeft, code.scrollTop] = snap.peek.scroll;
        g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: EASE, fill: 'forwards' });
      }
    }
    shownPeek = state.peek;
  }
  // A commit's details open downward from its row (in a chain, from what's above them), and fold
  // back into it when they close.
  function detailMotion(snap) {
    const el = main.querySelector('.hs-detail');
    const was = snap.detail && snap.detail.sha, now = el && el.dataset.detailOf;
    if (now && now !== was) {
      const h = el.getBoundingClientRect().height;
      el.style.overflow = 'hidden';
      const open = () => { el.style.overflow = ''; };
      unanchored(el.animate([{ height: '0px', opacity: 0 }, { height: h + 'px', opacity: 1 }], { duration: 200, easing: EASE })).finished.then(open, open);
    }
    if (was && was !== now) {
      const row = main.querySelector(`.hs-main[data-detail="${CSS.escape(was)}"]`)?.closest('.hs-row') || (!snap.detail.el.matches('.solo') ? null : snap.detail.place());
      if (row) { const g = closeGap(row, snap.detail.gap, [snap.detail.el]); g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: EASE, fill: 'forwards' }); }
    }
  }
  // After a render: the same things, moved.
  function motionAfter(snap) {
    // Another view, as drawing it took one (a chain that's gone): nothing moves either.
    if (!snap || snap.view !== viewKey()) { shownPeek = state.peek; return; }
    snap.sections.forEach(sectionMotion);
    if (snap.hint && snap.hint.mark) {
      const ids = new Set(snap.hint.mark);
      main.querySelectorAll('.tick.on[data-block]').forEach((t) => { if (ids.has(t.dataset.block)) popTick(t); });
    }
    if (snap.hint && snap.hint.more) moreMotion(snap.hint.more);
    if (snap.ol) olMotion(snap.ol);
    peekMotion(snap);
    detailMotion(snap);
    snap.threads.forEach((was, id) => { const el = thEl(id); if (el) threadMotion(was, el); });
    if (snap.away) awayMotion(snap.away);
  }
  const fadeOut = (el) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: EASE, fill: 'forwards' });
  const fadeIn = (el) => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 80, easing: EASE, fill: 'backwards' });
  // A thread or a note drawn again. Folded, what it held closes up under its header, fading; as it's
  // resolved, into the header that takes the place of its last lines and rises as they close.
  // Unfolded, it opens downward from its header, what it holds fading in. Unresolved, its header
  // closes over what stays. Any other change of size (a reply box opened) eases.
  function threadMotion(was, el) {
    const h = el.getBoundingClientRect().height, gone = was.h - h;
    if (Math.abs(gone) <= 3) return;
    const parts = (th) => { const head = th.querySelector(':scope > .th-fold'); return { head, body: [...th.children].filter((x) => x !== head) }; };
    const a = parts(was.el), b = parts(el);
    if (gone > 3 && b.head && a.body.length && !b.body.length) {
      const g = closeGap(b.head, gone, a.body);
      if (!a.head) { b.head.before(g); fadeIn(b.head); }
      fadeOut(g);
    } else if (gone > 3 && a.head && !b.head && b.body.length) {
      const g = closeGap(b.body[0], gone, [a.head]);
      b.body[0].before(g);
      fadeOut(g);
    } else if (!a.body.length && b.body.length) {
      unanchored(el.animate([{ height: was.h + 'px' }, { height: h + 'px' }], { duration: 280, easing: EASE }));
      b.body.forEach(fadeIn);
    } else unanchored(el.animate([{ height: was.h + 'px' }, { height: h + 'px' }], { duration: 200, easing: EASE }));
  }
  // A file's threads or notes off its diff: what follows their toggle, up to the next one.
  function awayOf(btn) {
    const out = [];
    for (let el = btn.nextElementSibling; el && !el.matches('.th-away'); el = el.nextElementSibling) out.push(el);
    return out;
  }
  const awayBtn = (k) => [...main.querySelectorAll('.th-away')].find((b) => b.dataset.act === k.act && b.dataset.p === k.p) || null;
  // Folded, they close up under their toggle, fading; unfolded, they open downward from it, fading in.
  function awayMotion(a) {
    const btn = awayBtn(a.key);
    if (!btn) return;
    const box = btn.parentElement, h = box.getBoundingClientRect().height, items = awayOf(btn);
    if (a.h - h > 3 && a.items.length && !items.length) fadeOut(closeGap(btn, a.h - h, a.items));
    else if (h - a.h > 3 && items.length && !a.items.length) {
      box.style.overflow = 'hidden';
      const open = () => { box.style.overflow = ''; };
      unanchored(box.animate([{ height: a.h + 'px' }, { height: h + 'px' }], { duration: 280, easing: EASE })).finished.then(open, open);
      items.forEach(fadeIn);
    }
  }
  // Comments new on GitHub since the page last asked fade in where they appear.
  function commentsMotion() {
    if (!GH.fresh.size) return;
    viewer.querySelectorAll('.cm[data-comment]').forEach((c) => {
      if (!GH.fresh.has(c.dataset.comment)) return;
      GH.fresh.delete(c.dataset.comment);
      if (moving()) c.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE });
    });
  }
  // Scrolls a row (or a section) to y below the pane's top, smoothly, then pulses it. Its place is
  // measured again each frame, so it lands right while what's above it still moves.
  let glide = 0;
  // A wheel stops a glide. It's listened to only while one runs: with a wheel listener anywhere in
  // the page, the browser sends every wheel to the main thread, where a long chain makes each one
  // cost a hit test.
  function stopGlide() {
    cancelAnimationFrame(glide);
    main.removeEventListener('wheel', stopGlide);
  }
  function glideTo(el, y, delay, after) {
    stopGlide();
    const done = after || (() => flashRow(el));
    if (!moving()) { placeRow(el, y); done(); return; }
    const target = () => main.scrollTop + el.getBoundingClientRect().top - main.getBoundingClientRect().top - y;
    // Far away, it jumps most of the way: gliding over thousands of rows would draw them all.
    const far = target() - main.scrollTop, span = main.clientHeight * 2;
    if (Math.abs(far) > span) main.scrollTop = target() - Math.sign(far) * span;
    const from = main.scrollTop, t0 = performance.now() + (delay || 0);
    const step = (now) => {
      if (!el.isConnected) return stopGlide();
      const p = Math.min(1, Math.max(0, (now - t0) / 260));
      main.scrollTop = from + (target() - from) * easeOut(p);
      if (p < 1) glide = requestAnimationFrame(step);
      else { stopGlide(); placeRow(el, y); done(); }
    };
    main.addEventListener('wheel', stopGlide, { passive: true });
    glide = requestAnimationFrame(step);
  }
  // Lands an element at y below the pane's top after a short glide over the last stretch: enough
  // to show the page went that way, without scrolling all the way there.
  const LAND = 120;
  function landAt(el, y) {
    if (!el) return;
    if (!moving()) { placeRow(el, y); return; }
    const d = el.getBoundingClientRect().top - main.getBoundingClientRect().top - y;
    if (Math.abs(d) > LAND) main.scrollTop += d - Math.sign(d) * LAND;
    glideTo(el, y, 0, () => {});
  }
  main.addEventListener('pointerdown', stopGlide);

  // The open commit's row and details on screen, scrolling no more than that takes.
  function revealDetail() {
    const panel = main.querySelector('.hs-detail');
    if (!panel) return;
    const box = main.getBoundingClientRect(), top = box.top + headH() + 8, bottom = box.bottom - 72;
    const r0 = (panel.previousElementSibling || panel).getBoundingClientRect(), r1 = panel.getBoundingClientRect();
    let dy = r1.bottom > bottom ? r1.bottom - bottom : 0;
    if (r0.top - dy < top) dy = r0.top - top;
    if (dy) main.scrollTo({ top: main.scrollTop + dy, behavior: moving() ? 'smooth' : 'auto' });
  }
  // A long block of code is cut, between two rows, into blocks of a hundred rows: off screen, each
  // skips layout and paint as one (see .code in the page's style), so a scroll checks a few blocks
  // rather than every row. The blocks cut from one are marked .cont. Each is as tall as a row for
  // each thing it holds until it's first drawn. (A test's code in its outline stays whole: the
  // outline's motion knows it as one piece.)
  const CUT = 100;
  function cutCode(root) {
    root.querySelectorAll('.code:not(.ol-code)').forEach((code) => {
      let at = code, rows = 0, prevRow = false;
      for (const el of [...code.children]) {
        const row = el.matches('.ln, .sl');
        if (row && prevRow && rows >= CUT) {
          const next = code.cloneNode(false);
          next.classList.add('cont');
          at.after(next);
          at = next;
          rows = 0;
        }
        if (at !== code) at.appendChild(el);
        if (row) rows++;
        prevRow = row;
      }
    });
    if (!wrapOn()) { root.querySelectorAll('.code').forEach((c) => c.style.setProperty('--rows', c.childElementCount)); return; }
    const cols = Math.max(16, Math.floor((main.clientWidth - 66 - 12) / (codeSize() * 0.6)));
    root.querySelectorAll('.code').forEach((c) => {
      let rows = 0;
      for (const el of c.children) {
        const tx = el.matches('.ln') && el.querySelector(':scope > .tx');
        const len = tx ? tx.textContent.length : 0, ind = tx ? indentOf(tx.textContent) : 0;
        rows += len <= cols ? 1 : 1 + Math.ceil((len - cols) / Math.max(8, cols - ind - 2));
      }
      c.style.setProperty('--rows', rows);
    });
  }
  // ---------- a view drawn again: in place, what's the same kept as the browser drew it. Drawn
  // anew, a block of code is as tall as its rows until it shows (a hunk's divider is taller), and
  // its rows show a frame after it: the page would move, and the code flash. So what's the same
  // stays; a block of code that changed, or what holds one, is brought up to date where it is;
  // anything else that changed is replaced, as the motion expects (what went out of the page
  // closes up, where it was).
  const LOOK = 40;
  const field = (n) => n.nodeType === 1 && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT');
  const same = (a, b) => !field(a) && a.isEqualNode(b);
  // The same element with other insides: its tag and attributes are.
  const alike = (a, b) => {
    if (a.nodeType !== 1 || b.nodeType !== 1 || a.tagName !== b.tagName || a.attributes.length !== b.attributes.length) return false;
    for (const { name, value } of b.attributes) if (a.getAttribute(name) !== value) return false;
    return true;
  };
  // Brought up to date in place: a block of code, as another block; what holds one, or comes to
  // hold one, as what holds one.
  const isCode = (n) => n.classList.contains('code');
  const patchable = (a, b) => a.nodeType === 1 && b.nodeType === 1 && a.tagName === b.tagName && !field(a)
    && (isCode(a) && isCode(b) || !isCode(a) && !isCode(b) && (!!a.querySelector('.code') || !!b.querySelector('.code')));
  function drawIn(live, next) {
    const was = [...live.childNodes], now = [...next.childNodes];
    // Where x is among a list's next few, or -1.
    const ahead = (list, from, x) => { for (let k = from; k < Math.min(list.length, from + LOOK); k++) if (same(list[k], x)) return k; return -1; };
    let i = 0;
    for (let j = 0; j < now.length;) {
      const a = was[i], b = now[j];
      if (a && same(a, b)) { i++; j++; continue; }
      // The same a little further on, one side or the other: what's before it went, or came.
      if (a && !alike(a, b)) {
        const k = ahead(was, i + 1, b), n = ahead(now, j + 1, a);
        if (k >= 0 && (n < 0 || k - i <= n - j)) { while (i < k) was[i++].remove(); continue; }
        if (n >= 0) { while (j < n) live.insertBefore(now[j++], a); continue; }
      }
      if (a && patchable(a, b)) {
        for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
        for (const { name, value } of b.attributes) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
        drawIn(a, b);
      } else if (a) a.replaceWith(b);
      else live.appendChild(b);
      i++;
      j++;
    }
    while (i < was.length) was[i++].remove();
  }
  // What follows (precedes) an element in its block of code, across the cuts.
  const nextIn = (el) => el.nextElementSibling || (el.parentElement && el.parentElement.nextElementSibling && el.parentElement.nextElementSibling.matches('.code.cont') ? el.parentElement.nextElementSibling.firstElementChild : null);
  const prevIn = (el) => el.previousElementSibling || (el.parentElement && el.parentElement.matches('.code.cont') && el.parentElement.previousElementSibling ? el.parentElement.previousElementSibling.lastElementChild : null);
  // A block of code and the blocks cut from it.
  function codeRun(code) {
    while (code.matches('.cont') && code.previousElementSibling && code.previousElementSibling.matches('.code')) code = code.previousElementSibling;
    const out = [code];
    for (let c = code.nextElementSibling; c && c.matches('.code.cont'); c = c.nextElementSibling) out.push(c);
    return out;
  }
  // ---------- render
  function render(opts) {
    opts = opts || {};
    const snap = motionBefore();
    const keep = main.scrollTop;
    // A graph scrolled within its box stays scrolled as it's drawn again.
    const gs = main.querySelector('.graph-scroll'), graphAt = gs && { view: viewKey(), x: gs.scrollLeft, y: gs.scrollTop };
    const gds = main.querySelector('.gd:not([hidden]) .gd-scroll'), gdAt = gds && { x: gds.scrollLeft, y: gds.scrollTop };
    const fresh = viewKey() !== GD.view;
    if (fresh) { GD.view = viewKey(); GD.folded = null; if (state.gdrop && state.gdrop.view !== GD.view) state.gdrop = null; }
    // A comment being typed keeps its focus, caret and scroll through the new page.
    const ae = document.activeElement;
    const typing = ae && ae.dataset && ae.dataset.draft != null && viewer.contains(ae) ? { key: ae.dataset.draft, s: ae.selectionStart, e: ae.selectionEnd, top: ae.scrollTop } : null;
    navStep(keep);
    renderSide();
    renderReviewBar();
    const v = state.view;
    MARKS = null;
    lit = '';
    const page = document.createElement('template');
    try {
      page.innerHTML = v.kind === 'chain' ? renderChain(v.id) : v.kind === 'map' ? renderMap(v.family) : v.kind === 'standalone' ? renderStandalone() : v.kind === 'group' ? renderGroup(v.id) : v.kind === 'search' ? renderSearch() : v.kind === 'source' ? renderSource(v) : v.kind === 'conversation' ? renderConversation() : v.kind === 'history' ? renderHistory() : v.kind === 'tests' ? renderTests() : renderFile(v.path);
    } catch (e) {
      page.innerHTML = `<div class="empty">This view failed to render: ${esc(e && e.message ? e.message : String(e))}. Reloading the page may help; if not, it’s a bug in untangle.</div>`;
      console.error(e);
    }
    // Cut as it shows, with the pinned groups' and the graph's places under its header. Another
    // view takes the last one's place; the same view is drawn again in place.
    cutCode(page.content);
    const fvHead = page.content.querySelector('.fv-head');
    if (fvHead) {
      const under = document.createElement('template');
      under.innerHTML = '<div class="ol-pinw" aria-hidden="true"><div class="ol-pin"></div></div>' + (gdHas() ? '<div class="gd-w"><div class="gd" role="dialog" aria-label="The chain’s graph" hidden></div></div>' : '');
      fvHead.after(under.content);
    }
    if (fresh) main.replaceChildren(page.content);
    else {
      // Motion under way ends first: what was opening is open, what was closing is gone.
      main.querySelectorAll('.ghost').forEach((g) => g.remove());
      main.querySelectorAll('.grow').forEach((w) => w.replaceWith(...w.childNodes));
      drawIn(main, page.content);
    }
    fitBoxes(main);
    restorePeekScroll();
    const gs2 = graphAt && graphAt.view === viewKey() && main.querySelector('.graph-scroll');
    if (gs2) { gs2.scrollLeft = graphAt.x; gs2.scrollTop = graphAt.y; }
    viewer.querySelectorAll('[data-compare]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.compare === state.compare)));
    renderTop();
    renderWhere();
    renderCompose();
    paintPick();
    // Contents closes once what was chosen in it is open.
    if (SIDE.open && viewKey() !== SIDE.at) sideDrawer(false);
    if (PICK.path && PICK.view !== viewKey()) { PICK.path = PICK.a = PICK.b = null; }
    viewer.classList.toggle('split', sideBySide());
    if (opts.line) {
      const el = main.querySelector(`[data-n="${opts.line}"]`);
      if (el) placeRow(el, headH() + 60); else main.scrollTop = opts.top ? 0 : keep;
      // A line still loading, or lines loading above it: shown again once they're there, and
      // marked then.
      pendingLine = !el || main.querySelector('.ln.loading') ? { view: state.view, line: opts.line } : null;
      if (el && !pendingLine) arrive(el, 'arrive');
    } else if (opts.section != null) {
      const el = main.querySelector('#sec-' + opts.section);
      if (el) { placeRow(el, headH() + 8); arrive(el, 'flash-sec'); }
    } else if (opts.scroll != null) main.scrollTop = opts.scroll;
    else if (opts.top) main.scrollTop = 0;
    else main.scrollTop = keep;
    if (opts.reveal) revealDetail();
    olPin();
    GD.order = state.view.kind === 'chain' && M().chains[state.view.id] ? gdOrder(M().chains[state.view.id]) : [];
    roomToFold();
    foldGraph();
    spyHere();
    if (state.gdrop) gdRestore(gdAt);
    const cur = side.querySelector('[aria-current="true"]');
    if (cur && opts.top && !cur.closest('.sb-top')) {
      const topH = (side.querySelector('.sb-top') || {}).offsetHeight || 0;
      if (cur.offsetTop < side.scrollTop + topH || cur.offsetTop > side.scrollTop + side.clientHeight - 40) side.scrollTop = cur.offsetTop - topH - (side.clientHeight - topH) / 3;
    }
    viewer.classList.toggle('local', localMode());
    if (GH.on || NT.on) {
      main.appendChild(addBtn);
      addBtn.classList.remove('on');
      if (NT.reveal != null) {
        const el = main.querySelector(`[data-note="${NT.reveal}"]`);
        if (el) { placeRow(el, headH() + 40); el.classList.add('flash-th'); }
        NT.reveal = null;
      }
      if (GH.reveal) {
        const el = [...main.querySelectorAll('[data-thread]')].find((x) => x.dataset.thread === GH.reveal);
        if (el) { placeRow(el, headH() + 40); el.classList.add('flash-th'); }
        GH.reveal = null;
      }
      const findDraft = (key) => [...viewer.querySelectorAll('[data-draft]')].find((x) => x.dataset.draft === key);
      const listing = MN.ta ? MN.key : null;
      mentionClose();
      if (typing) {
        const ta = findDraft(typing.key);
        if (ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(typing.s, typing.e); ta.scrollTop = typing.top; if (listing === typing.key) mentionUpdate(ta); }
      } else if (GH.focus) {
        const ta = findDraft(GH.focus);
        if (ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); if (!opts.top) ta.scrollIntoView({ block: 'nearest' }); }
      }
      GH.focus = null;
    }
    main.classList.toggle('scrolled', main.scrollTop > 2);
    motionAfter(snap);
    glowRows();
    commentsMotion();
    if (MENU.open) renderMenu();
    renderPill();
    mini.update();
  }
  // The top bar: the pull request (its number quiet), its state, the commit reviewed and a way to
  // newer ones.
  let topHtml = '';
  function renderTop() {
    const el = $('#vw-title');
    if (!el) return;
    const h = prHtml();
    if (h !== topHtml) { el.innerHTML = h; topHtml = h; }
  }
  // `head`: Contents' head, in a narrow window: its state and commit on a line, then its title.
  function prHtml(head) {
    const raw = M().raw.title || '';
    const m = /^#(\d+)\s+(.*)$/.exec(raw);
    // `code` in a title reads as code.
    const words = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');
    const name = m ? `<span class="t-num">#${m[1]}</span>${words(m[2])}` : words(raw);
    const pr = GH.data && GH.data.pr;
    const st = pr ? (pr.draft ? 'draft' : String(pr.state || '').toLowerCase()) : '';
    const sha = (CONFIG.head || M().raw.right || '').slice(0, 7);
    const title = CONFIG.url ? `<a class="t-pr" href="${esc(CONFIG.url)}" target="_blank" rel="noopener noreferrer" title="${esc(raw)}: open on GitHub">${name}</a>` : `<span class="t-pr" title="${esc(raw)}">${name}</span>`;
    const facts = (st ? `<span class="t-state ${esc(st)}">${{ open: 'Open', merged: 'Merged', closed: 'Closed', draft: 'Draft' }[st] || esc(st)}</span>` : '')
      + `<span class="t-commit" title="${esc(CONFIG.where || M().raw.label || '')}">${hxOn() ? `<button type="button" class="t-head${state.lens ? ' on' : ''}" data-act="menu" data-menu="lens" aria-haspopup="dialog" aria-expanded="${MENU.open === 'lens'}" title="${state.lens ? `Only these changes count: ${esc(lensLabel())}. Pick others, or all of them` : 'Changes from every commit: pick some to review only theirs'}"><span>${state.lens ? esc(lensLabel()) : esc(sha)}</span>${ICON.chevronDown}</button>` : esc(sha)}${CONFIG.served ? iconBtn(ICON.refresh, 'Look for new commits, and review them here', 'data-act="refresh"') : ''}</span>`
      + `<span class="t-unsaved" title="${esc(unsavedWhy)}">Marks not saved</span>`;
    return head ? `<div class="sb-pr-row">${facts}</div>${title}` : title + facts;
  }
  // The app bar, in a narrow window, names where you are: the view, and under it what the
  // header says about your place in it (the member being read), else its facts.
  let whereHtml = '';
  function renderWhere() {
    const el = $('#vw-where');
    if (!el || !compact()) return;
    const crumbs = main.querySelector('.fv-head .crumbs'), here = main.querySelector('.fv-head .fv-here'), facts = main.querySelector('.fv-head .facts');
    const names = crumbs ? [...crumbs.querySelectorAll('b')] : [];
    const title = (names.length ? names[names.length - 1].textContent : crumbs ? crumbs.textContent : '').trim() || (M().raw.title || '');
    const sub = here && here.textContent.trim() ? here.textContent.replace(/^Reading\s+/, '').trim() : facts ? facts.textContent.replace(/\s+/g, ' ').trim() : '';
    const h = `<b>${esc(title)}</b><small>${esc(sub)}</small>`;
    if (h !== whereHtml) { el.innerHTML = h; whereHtml = h; }
  }
  function openFile(path, line) {
    state.view = { kind: 'file', path };
    state.peek = null;
    // The Files tab shows it.
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) { const dir = parts.slice(0, i).join('/'); state.closedDirs.delete(dir); state.closedDirs.delete('gen:' + dir); }
    if (line) {
      const hl = M().head.get(path + ':' + line);
      if (hl) { const k = 'file|' + path + '#' + hl.hi + ':0'; state.collapsed.delete(k); state.expanded.add(k); }
    }
    render(line ? { line: Number(line), top: true } : { top: true });
  }
  const headH = () => { if (compact()) return 0; const hd = main.querySelector('.fv-head'); return hd ? hd.offsetHeight : 0; };
  // Puts a row y pixels below the top of the code pane. Rows off screen only estimate their
  // height until they're drawn (a long line wraps when side by side), so the row is put there
  // again once the rows around it have been drawn.
  function placeRow(row, y) {
    const put = () => { if (row.isConnected) main.scrollTop += row.getBoundingClientRect().top - main.getBoundingClientRect().top - y; };
    put();
    requestAnimationFrame(() => requestAnimationFrame(() => { put(); requestAnimationFrame(put); }));
  }
  // The first line on screen (in which block of code, and how far down), to keep it where it is
  // while the view changes around it.
  function lineOnScreen() {
    const top = main.getBoundingClientRect().top + headH();
    const codes = [...main.querySelectorAll('.code:not(.cont)')];
    for (const el of main.querySelectorAll('[data-n]')) {
      if (!el.dataset.n) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom <= top + 1) continue;
      const code = el.closest('.code');
      return { code: code ? codes.indexOf(codeRun(code)[0]) : -1, n: Number(el.dataset.n), off: r.top - top };
    }
    return null;
  }
  function backTo(at) {
    if (!at) return;
    const code = main.querySelectorAll('.code:not(.cont)')[at.code];
    if (!code) return;
    const rows = codeRun(code).flatMap((c) => [...c.querySelectorAll('[data-n]')]).filter((x) => x.dataset.n);
    const el = rows.find((x) => Number(x.dataset.n) === at.n) || rows.find((x) => Number(x.dataset.n) > at.n);
    if (el) placeRow(el, headH() + at.off);
  }
  // ---------- getting around: a view's changes in order, the one you're on, the next one. A
  // change shows as its review mark, or as the divider of a folded section with changes to review
  // (it opens on the way). ↑ and ↓ go through every change; j, k and the review pill through the
  // ones to review, counted from the one they last went to while it's on screen, else from the
  // top of the screen, wrapping around at either end.
  let navAt = null;
  // What a query of the pane finds, kept until the pane's DOM changes: scrolling asks some every
  // frame, and in a long chain each walks thousands of rows. Changes not yet delivered count, so a
  // query right after a render finds the new rows; the header's and the pinned groups' don't, as
  // they change while the pane scrolls and hold none of what's asked.
  const paneFound = new Map();
  const counts = (list) => list.some((m) => !(m.target.closest && m.target.closest('.fv-head, .ol-pinw')));
  const paneChanges = new MutationObserver((list) => { if (counts(list)) paneFound.clear(); });
  paneChanges.observe(main, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'id', 'data-block', 'data-nav', 'data-mark', 'data-unit', 'data-p', 'data-olf', 'data-ol'] });
  function paneQuery(key, find) {
    if (counts(paneChanges.takeRecords())) paneFound.clear();
    if (!paneFound.has(key)) paneFound.set(key, find());
    return paneFound.get(key);
  }
  const rowOf = (el) => el.closest('.ln, .sl, .hh, .ol-row');
  // The first of some elements in the pane's order for which a test, false before it and true from
  // it on, holds: found by halving, as scrolling asks every frame and a long chain has thousands.
  function firstWhere(list, ok) {
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ok(list[mid])) hi = mid; else lo = mid + 1; }
    return lo;
  }
  const markId = (el) => el.dataset.block || 'sec:' + el.dataset.sec;
  // A chain shows other chains' changes in its context lines: j, k and the pill skip them.
  const changeMarks = (open) => paneQuery(open ? 'marks open' : 'marks', () => {
    const seen = new Set();
    return [...main.querySelectorAll(open ? '.tick[data-block]:not(.on):not(.lens-out), .hh[data-nav], .ol-row[data-nav]' : '.tick[data-block]:not(.lens-out), .hh[data-nav], .ol-row[data-mark]')].filter((el) => {
      if (open && el.closest('.other')) return false;
      const block = M().blockById.get(el.dataset.block);
      const key = state.view.kind === 'group' ? block?.id : el.dataset.unit || block?.unit || block?.id;
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
  // Where a change is put when you go to it: a little below the header.
  const readY = () => main.getBoundingClientRect().top + headH() + 48;
  const follows = (a, b) => { const p = a.compareDocumentPosition(b); return !!(p & Node.DOCUMENT_POSITION_FOLLOWING) && !(p & Node.DOCUMENT_POSITION_CONTAINED_BY); };
  // The change you're on: the one you last went to while it's on screen, else the first one to
  // review on screen.
  function currentMark() {
    const box = main.getBoundingClientRect(), top = box.top + headH();
    const seen = (el) => { const r = rowOf(el).getBoundingClientRect(); return r.bottom > top && r.top < box.bottom - 56; };
    const open = changeMarks(true);
    if (navAt) { const el = open.find((x) => markId(x) === navAt); if (el && seen(el)) return el; }
    const first = open[firstWhere(open, (el) => rowOf(el).getBoundingClientRect().bottom > top)];
    return first && seen(first) ? first : null;
  }
  // Where a jump landed, marked from the start (a mark of the kind elsewhere ends).
  function arrive(el, cls) {
    main.querySelectorAll('.' + cls).forEach((x) => x.classList.remove(cls));
    void el.offsetWidth;
    el.classList.add(cls);
  }
  function flashRow(row) {
    main.querySelectorAll('.flash').forEach((x) => x.classList.remove('flash'));
    void row.offsetWidth;
    row.classList.add('flash');
  }
  function goToMark(el, delay) {
    if (el.matches('.hh')) {
      const key = el.dataset.sec;
      state.collapsed.delete(key); state.expanded.add(key);
      render();
      const band = [...main.querySelectorAll('.hh[data-sec]')].find((x) => x.dataset.sec === key);
      const after = (sel) => band && [...main.querySelectorAll(sel)].find((x) => follows(band, x));
      el = after('.tick[data-block]:not(.on)') || after('.tick[data-block]');
      if (!el) return false;
    }
    navAt = markId(el);
    glideTo(rowOf(el), readY() - main.getBoundingClientRect().top, delay, () => { flashRow(rowOf(el)); renderPill(); });
    renderPill();
    return true;
  }
  function gotoChange(step, open) {
    const box = main.getBoundingClientRect(), ref = readY();
    const y = (el) => rowOf(el).getBoundingClientRect().top;
    let marks = changeMarks(open);
    // Nothing left to review here: every change, then.
    if (!marks.length && open) marks = changeMarks(false);
    if (!marks.length) return false;
    let i = navAt ? marks.findIndex((el) => markId(el) === navAt) : -1;
    if (i >= 0 && y(marks[i]) >= box.top && y(marks[i]) < box.bottom) i += step;
    else if (step > 0) i = marks.findIndex((el) => y(el) > ref + 2);
    else { i = -1; marks.forEach((el, k) => { if (y(el) < ref - 2) i = k; }); }
    if (i < 0 || i >= marks.length) i = step > 0 ? 0 : marks.length - 1;
    return goToMark(marks[i]);
  }
  // After marking: the next change to review after `anchor` (found again in the new page), or
  // the first one left.
  function goNextAfter(find) {
    const anchor = find();
    const marks = changeMarks(true);
    navAt = null;
    const next = anchor ? marks.find((x) => follows(anchor, x)) : null;
    // After the fold has started, so the eye goes from the folding hunk to the next change.
    if (next || marks.length) return goToMark(next || marks[0], 160);
    renderPill();
    return false;
  }
  // The divider of the section a row is in.
  function bandOf(el) {
    const code = el.closest('.code');
    let band = null;
    if (code) code.querySelectorAll('.hh[data-sec]').forEach((h) => { if (follows(h, el)) band = h; });
    return band;
  }
  const findBand = (key) => () => [...main.querySelectorAll('.hh[data-sec]')].find((x) => x.dataset.sec === key) || null;
  // An outline's row, or the line of reviewed rows it folded into.
  const olRowOrFold = (key) => [...main.querySelectorAll('.ol-row[data-ol]')].find((x) => x.dataset.ol === key) || [...main.querySelectorAll('.ol-fold[data-in]')].find((x) => x.dataset.in.split(' ').includes(key)) || null;
  // Marking from inside a test file's outline: what it folds there moves too.
  const markHint = (ids, el) => { const sec = el && el.closest && el.closest('.ol-sec[data-olf]'); return sec ? { mark: ids, olf: sec.dataset.olf } : { mark: ids }; };
  // Space: marks the change you're on reviewed and goes to the next one to review. With none on
  // screen, it only goes to the next one.
  function markAndNext() {
    const el = currentMark();
    if (!el) return gotoChange(1, true);
    if (el.matches('.hh')) return goToMark(el);
    if (el.matches('.ol-row')) {
      // An outline's row: its own lines (a test's body, a group's setup).
      const key = el.dataset.ol, blocks = blocksOf(el.dataset.mark.split(' ')).filter((b) => b && b.edits.length);
      toggleBlocks(blocks);
      hint(markHint(blocks.map((b) => b.id), el));
      render();
      return goNextAfter(() => olRowOrFold(key));
    }
    const id = el.dataset.block, b = M().blockById.get(id);
    if (!b) return false;
    const band = bandOf(el), key = band && band.dataset.sec;
    const unit = state.view.kind !== 'group' && b.unit && M().unitById.get(b.unit);
    const blocks = unit ? blocksOf(unit.blocks) : [b];
    toggleBlocks(blocks);
    hint({ mark: blocks.map((block) => block.id) });
    render();
    return goNextAfter(() => [...main.querySelectorAll('.tick[data-block]')].find((x) => x.dataset.block === id) || (key && findBand(key)()));
  }
  // Shift+Space: marks the hunk the change is in, or in a chain, its member.
  function markScope() {
    const el = currentMark();
    if (!el) return gotoChange(1, true);
    if (el.matches('.hh')) return goToMark(el);
    if (el.matches('.ol-row')) {
      // An outline's row: everything its mark covers (a group's setup and the calls under it).
      const key = el.dataset.ol, tick = el.querySelector('.ol-tick[data-blocks]');
      const blocks = blocksOf((tick ? tick.dataset.blocks : el.dataset.mark).split(' ')).filter((b) => b && b.edits.length && blockIn(b) && !doneL(b));
      if (!blocks.length) return false;
      setEdits(blocks.flatMap((b) => b.edits), true);
      hint(markHint(blocks.map((b) => b.id), el));
      render();
      return goNextAfter(() => olRowOrFold(key));
    }
    const sec = state.view.kind === 'chain' ? el.closest('.sec[id]') : null;
    const band = bandOf(el);
    const btn = sec ? sec.querySelector('.sec-h [data-act="mark-blocks"]') : band && band.querySelector('[data-act="mark-blocks"]');
    if (!btn) return false;
    const blocks = blocksOf(btn.dataset.blocks.split(' ')).filter((b) => b && b.edits.length && blockIn(b) && !doneL(b));
    if (!blocks.length) return false;
    if (commitLens()) markCommitLines(blocks, true);
    else setEdits(blocks.flatMap((b) => b.edits), true);
    blocks.forEach((b) => state.blockDiff.delete(b.id));
    const secId = sec && sec.id, key = band && band.dataset.sec;
    hint({ mark: blocks.map((b) => b.id) });
    render();
    return goNextAfter(() => (secId ? main.querySelector('#' + secId) : key && findBand(key)()));
  }
  // c: a comment on the line you're on.
  function commentHere() {
    if (!canCommentLines()) { if (localMode()) toast('The notes aren’t loaded yet.'); else if (GH.on) toast(GH.stale ? 'GitHub has newer commits: refresh to comment on lines.' : 'Comments aren’t loaded yet.'); return; }
    const el = currentMark();
    let row = el && !el.matches('.hh') ? rowOf(el) : null;
    if (!row) { const ref = readY(); row = [...main.querySelectorAll('.code[data-p] .ln[data-c], .code[data-p] .sl')].find((r) => r.getBoundingClientRect().bottom > ref) || null; }
    if (!row) return;
    const cell = row.matches('[data-c]') ? row : row.querySelector('.half.r[data-c]') || row.querySelector('[data-c]');
    const code = cell && cell.closest('.code[data-p]');
    if (!code) return;
    const [sd, line] = cell.dataset.c.split(':');
    openCompose({ path: code.dataset.p, side: sd === 'L' ? 'LEFT' : 'RIGHT', line: Number(line) }, false);
  }
  // The review pill: where you are among the view's changes to review, and the action that does
  // the most, marking the change and going to the next.
  const PILL_VIEWS = new Set(['chain', 'file', 'standalone', 'group', 'tests']);
  let pillHtml = '';
  const openIn = (el) => (el.matches('.hh') ? Number(el.dataset.open) || 1 : 1);
  function renderPill() {
    const el = $('#vw-pill');
    if (!el) return;
    let h = '';
    el.classList.toggle('pick', !!PICK.path);
    if (PICK.path) h = pickBarHtml();
    else if (PILL_VIEWS.has(state.view.kind) && main.querySelector('.tick[data-block], .hh[data-nav], .ol-row[data-mark]')) {
      const marks = changeMarks(true);
      const total = marks.reduce((x, m) => x + openIn(m), 0);
      if (total) {
        const cur = currentMark(), ref = readY();
        let at = cur ? marks.indexOf(cur) : firstWhere(marks, (m) => rowOf(m).getBoundingClientRect().top >= ref - 4);
        if (at >= marks.length) at = -1;
        const n = at < 0 ? total : marks.slice(0, at).reduce((x, m) => x + openIn(m), 0) + 1;
        h = `${iconBtn(ICON.chevronLeft, 'Previous change to review (k)', 'data-act="pill-step" data-step="-1"')}<span class="pill-n" aria-live="polite"><b>${n}</b> of ${total}</span>${iconBtn(ICON.chevronRight, 'Next change to review (j)', 'data-act="pill-step" data-step="1"')}<span class="pill-sep"></span>${canCommentLines() ? `<button type="button" class="ib pill-note" data-act="comment-here" title="${localMode() ? 'Write a note' : 'Comment'} on the change you’re on (c)" aria-label="${localMode() ? 'Write a note' : 'Comment'} on the change you’re on">${ICON.comment}</button>` : ''}<button type="button" class="pill-act" data-act="mark-next" title="Mark the change you’re on reviewed, and go to the next one"><span class="pill-l" data-s="Mark and next">Mark and go to the next</span><kbd>Space</kbd></button>`;
      } else {
        const nx = nextUnreviewed();
        h = `<span class="pill-msg">${lensOn() && !main.querySelector('.tick[data-block]:not(.lens-out)') ? 'Nothing in the lens here' : 'All reviewed here'}</span>${nx ? '<button type="button" class="pill-act" data-act="next-open" title="The next chain with changes to review">Next chain<kbd>n</kbd></button>' : ''}`;
      }
    }
    el.hidden = !h;
    if (h === pillHtml) return;
    const old = el.querySelector('.pill-n b'), was = old ? Number(old.textContent) : null;
    el.innerHTML = h;
    pillHtml = h;
    // The count rolls to its new number.
    const b = el.querySelector('.pill-n b'), now = b ? Number(b.textContent) : null;
    if (b && was != null && now !== was && moving()) b.animate([{ transform: `translateY(${now > was ? 6 : -6}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 200, easing: EASE });
  }
  let scrollRaf = 0;
  main.addEventListener('scroll', () => {
    if (scrollRaf) return;
    if (state.gdrop) gdClose();
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; main.classList.toggle('scrolled', main.scrollTop > 2); main.classList.toggle('aside', main.scrollLeft > 0); renderPill(); spyHere(); foldGraph(); mini.scrolled(); olPin(); });
    clearTimeout(NAV.saveT);
    NAV.saveT = setTimeout(() => { const cur = NAV.stack[NAV.at]; if (cur) { cur.top = main.scrollTop; navSave(cur); } }, 400);
  }, { passive: true });
  // n and p: the next and previous chain with changes to review.
  function goChain(step) {
    const nx = nextUnreviewed(step);
    if (!nx) return toast('Everything is reviewed.');
    state.view = nx; state.peek = null; state.focus = null; toChains();
    render({ top: true });
  }
  // The keys, on ?.
  const MOD = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl';
  const jumpKey = $('#vw-jump kbd');
  if (jumpKey) jumpKey.textContent = MOD + ' K';
  let keysEl = null;
  function toggleKeys(on) {
    if (!keysEl) {
      keysEl = document.createElement('div');
      keysEl.className = 'keys';
      keysEl.setAttribute('role', 'dialog');
      keysEl.setAttribute('aria-label', 'Keyboard shortcuts');
      keysEl.tabIndex = -1;
      keysEl.hidden = true;
      const k = (...keys) => keys.map((x) => `<kbd>${x}</kbd>`).join('');
      keysEl.innerHTML = '<h2>Keys</h2><dl>'
        + [[k('j', 'k'), 'Next and previous change to review'], [k('Space'), 'Mark the change reviewed and go to the next one'], [k('Shift', 'Space'), 'Mark the hunk, or the member in a chain'],
          [k('n', 'p'), 'Next and previous chain with changes to review'], [k('g'), 'The chain’s graph, over the code, and back'], [k(MOD, 'K'), 'Jump to a chain, file, symbol or thread'],
          [k('c'), 'Comment on the line you’re on'], [k(...BACK_KEY.split(' ')), 'Back to where you were'], [k(MOD, 'B'), 'Show or hide the sidebar'], [k('Esc'), 'Close the peek, the palette, a menu or a commit’s details; then show every change again (the lens off)'], [k('?'), 'These keys']]
          .map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('') + '</dl>';
      viewer.appendChild(keysEl);
    }
    const show = on == null ? keysEl.hidden : on;
    keysEl.hidden = !show;
    scrim(show ? 'keys' : null);
    if (show) keysEl.focus();
  }
  let scrimEl = null;
  // The dim layer under a dialog; a click on it closes the dialog.
  function scrim(owner) {
    if (!scrimEl) { scrimEl = document.createElement('div'); scrimEl.className = 'scrim'; scrimEl.hidden = true; viewer.appendChild(scrimEl); scrimEl.addEventListener('click', () => { if (scrimEl.dataset.owner === 'keys') toggleKeys(false); else palClose(); }); }
    scrimEl.hidden = !owner;
    scrimEl.dataset.owner = owner || '';
  }

  // ---------- @ and # in comments
  // Typing @ suggests people (and teams) to mention, # issues and pull requests to link, as on
  // GitHub. People already in the conversation show at once; GitHub's answers follow as you type.
  // ↑/↓ choose, Enter or Tab inserts, Esc closes.
  const MN = { ta: null, key: null, kind: null, query: '', start: 0, items: [], active: 0, loading: 0, cache: new Map(), timer: null };
  const mnPop = document.createElement('div');
  mnPop.className = 'mn-pop';
  mnPop.setAttribute('role', 'listbox');
  mnPop.hidden = true;
  viewer.appendChild(mnPop);
  // The @ or # being typed just before the caret: @login, @org/team, #123 or #word.
  function mentionAt(ta) {
    if (ta.selectionStart !== ta.selectionEnd) return null;
    const before = ta.value.slice(0, ta.selectionStart);
    const m = /(^|[\s([{,;])([@#])([\w.\/-]{0,40})$/.exec(before);
    return m ? { kind: m[2], query: m[3], start: before.length - m[3].length - 1 } : null;
  }
  // Who's in this conversation, for @ before GitHub answers.
  function participants() {
    const d = GH.data, seen = new Map();
    if (!d) return [];
    const add = (p) => { if (p && p.login && p.login !== 'ghost' && !seen.has(p.login.toLowerCase())) seen.set(p.login.toLowerCase(), { kind: 'user', value: p.login, label: p.login, detail: '', avatar: p.avatar }); };
    add(d.pr.author);
    d.reviews.forEach((r) => add(r.author));
    d.threads.forEach((t) => t.comments.forEach((c) => add(c.author)));
    d.comments.forEach((c) => add(c.author));
    return [...seen.values()];
  }
  function mentionItems() {
    const q = MN.query.toLowerCase();
    // GitHub's answer for this query, or for the longest part of it already asked, narrowed here.
    let known = null;
    for (let i = q.length; i >= 0 && !known; i--) known = MN.cache.get(MN.kind + q.slice(0, i)) || null;
    const fits = (it) => !q || it.value.toLowerCase().includes(q) || it.detail.toLowerCase().includes(q) || (it.kind === 'issue' || it.kind === 'pr' ? it.value.startsWith(q) : false);
    const list = (MN.kind === '@' ? participants() : []).filter(fits).concat((known || []).filter(fits));
    const seen = new Set();
    const out = list.filter((it) => { const k = it.kind + it.value.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    // What starts with the query first.
    return out.sort((x, y) => (y.value.toLowerCase().startsWith(q) ? 1 : 0) - (x.value.toLowerCase().startsWith(q) ? 1 : 0)).slice(0, 10);
  }
  function mentionAsk() {
    const kind = MN.kind, q = MN.query.toLowerCase(), k = kind + q;
    if (MN.cache.has(k)) return;
    clearTimeout(MN.timer);
    MN.timer = setTimeout(() => {
      MN.loading++;
      mentionDraw();
      api('github', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'suggest', kind, query: q }) })
        .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error); return j; }))
        .then((j) => { MN.cache.set(k, j.items || []); }, () => { MN.cache.set(k, []); })
        .then(() => { MN.loading--; if (MN.ta) mentionDraw(); });
    }, 150);
  }
  // Where the caret is in a textarea, in the window: a hidden copy of its text up to the caret,
  // with the textarea's style, puts a marker there.
  function caretXY(ta) {
    const cs = getComputedStyle(ta), div = document.createElement('div');
    ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'tabSize'].forEach((p) => { div.style[p] = cs[p]; });
    Object.assign(div.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', top: '0', left: '-9999px' });
    div.textContent = ta.value.slice(0, ta.selectionStart);
    const mark = document.createElement('span');
    mark.textContent = '​';
    div.appendChild(mark);
    document.body.appendChild(div);
    const r = ta.getBoundingClientRect(), lh = parseFloat(cs.lineHeight) || 18;
    const at = { x: r.left + mark.offsetLeft - ta.scrollLeft, y: r.top + mark.offsetTop - ta.scrollTop, lh };
    div.remove();
    return at;
  }
  const STATE_CLS = { OPEN: 'open', DRAFT: 'draft', CLOSED: 'closed', MERGED: 'merged' };
  function mentionDraw() {
    if (!MN.ta) return;
    MN.items = mentionItems();
    if (MN.active >= MN.items.length) MN.active = Math.max(0, MN.items.length - 1);
    if (!MN.items.length && !MN.loading) { mnPop.hidden = true; return; }
    mnPop.innerHTML = MN.items.map((it, i) => {
      const lead = it.kind === 'issue' || it.kind === 'pr'
        ? `<span class="mn-ic ${STATE_CLS[it.state] || ''}">${it.kind === 'issue' ? ICON.issue : it.state === 'MERGED' ? ICON.merged : ICON.pr}</span>`
        : it.avatar ? `<img class="av" src="${esc(it.avatar + (it.avatar.includes('?') ? '&' : '?') + 's=40')}" alt="">` : `<span class="mn-ic">${ICON.discussion}</span>`;
      return `<button type="button" class="mn-it${i === MN.active ? ' on' : ''}" data-mn="${i}" role="option" aria-selected="${i === MN.active}" tabindex="-1">${lead}<b>${esc(it.label)}</b><span class="muted">${esc(it.detail)}</span></button>`;
    }).join('') + (MN.loading && !MN.items.length ? `<div class="mn-wait">Asking GitHub…</div>` : '');
    mnPop.hidden = false;
    const c = caretXY(MN.ta), w = Math.min(420, window.innerWidth - 16), h = mnPop.offsetHeight;
    const below = c.y + c.lh + 4 + h < window.innerHeight - 8;
    mnPop.style.left = `${Math.max(8, Math.min(c.x, window.innerWidth - w - 8))}px`;
    mnPop.style.top = `${below ? c.y + c.lh + 4 : Math.max(8, c.y - h - 4)}px`;
    const on = mnPop.querySelector('.mn-it.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }
  function mentionClose() {
    MN.ta = null;
    mnPop.hidden = true;
  }
  // Looks at the text before the caret: a suggestion list opens, follows, or closes.
  function mentionUpdate(ta) {
    const m = mentionAt(ta);
    if (!m) return mentionClose();
    const moved = MN.ta !== ta || MN.kind !== m.kind || MN.query !== m.query;
    Object.assign(MN, { ta, key: ta.dataset.draft, kind: m.kind, query: m.query, start: m.start });
    if (moved) { MN.active = 0; mentionAsk(); }
    mentionDraw();
  }
  function mentionInsert(i) {
    const it = MN.items[i], ta = MN.ta;
    if (!it || !ta) return;
    const token = MN.kind + it.value + ' ', end = ta.selectionStart;
    ta.value = ta.value.slice(0, MN.start) + token + ta.value.slice(end);
    fitBox(ta);
    const caret = MN.start + token.length;
    ta.setSelectionRange(caret, caret);
    setDraft(ta.dataset.draft, ta.value);
    mentionClose();
    ta.focus();
  }
  // Picked with the mouse: the textarea keeps the focus.
  mnPop.addEventListener('mousedown', (e) => {
    const b = e.target.closest('[data-mn]');
    e.preventDefault();
    if (b) mentionInsert(Number(b.dataset.mn));
  });
  // Choosing with the keyboard, before anything else hears the key.
  function mentionKey(e) {
    if (!MN.ta || e.target !== MN.ta || mnPop.hidden) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!MN.items.length) return false;
      MN.active = (MN.active + (e.key === 'ArrowDown' ? 1 : -1) + MN.items.length) % MN.items.length;
      mentionDraw();
    } else if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) || e.key === 'Tab') {
      if (!MN.items.length) return false;
      mentionInsert(MN.active);
    } else if (e.key === 'Escape') mentionClose();
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
  viewer.addEventListener('keyup', (e) => {
    if (e.target.dataset && e.target.dataset.draft != null && /^(Arrow(Left|Right)|Home|End)$/.test(e.key)) mentionUpdate(e.target);
  });
  viewer.addEventListener('click', (e) => { if (e.target.dataset && e.target.dataset.draft != null) mentionUpdate(e.target); });
  viewer.addEventListener('focusout', (e) => { if (e.target === MN.ta) setTimeout(() => { if (document.activeElement !== MN.ta) mentionClose(); }, 0); });
  window.addEventListener('resize', () => { fitBoxes(viewer); if (MN.ta) mentionDraw(); });
  main.addEventListener('scroll', () => { if (MN.ta) mentionDraw(); }, { passive: true });

  // ---------- refreshing in place
  // untangle looks up the pull request again; when it moved, it builds the new review while this
  // page keeps working, and the page then reloads on the same view. New commits show as a banner.
  const FRESH = { state: null, head: null, steps: [], error: null, latest: null, moved: null, timer: null };
  const RESUME = 'untangle:resume';
  function startRefresh() {
    if (!CONFIG.served || FRESH.state === 'checking' || FRESH.state === 'building') return;
    Object.assign(FRESH, { state: 'checking', error: null, steps: [] });
    renderFresh();
    api('refresh', { method: 'POST' }).then((r) => r.json()).then(onFresh).catch((e) => onFresh({ state: 'failed', error: e.message }));
  }
  function onFresh(j) {
    clearTimeout(FRESH.timer);
    if (j.state === 'current') { Object.assign(FRESH, { state: null, latest: null }); renderFresh(); return toast(`Up to date: ${String(j.head).slice(0, 7)} is the latest`); }
    Object.assign(FRESH, { state: j.state, head: j.head || FRESH.head, steps: j.steps || [], error: j.error || null });
    if (j.state === 'ready') return reloadHere();
    renderFresh();
    if (j.state === 'checking' || j.state === 'building') FRESH.timer = setTimeout(() => api('refresh').then((r) => r.json()).then(onFresh).catch(() => onFresh({ state: FRESH.state, head: FRESH.head, steps: FRESH.steps })), 700);
  }
  // Whether newer commits exist (asked at most every half minute by untangle, however many ask).
  function freshCheck() {
    if (!CONFIG.served || FRESH.state) return;
    api('refresh?check=1').then((r) => r.json()).then((j) => {
      const newer = j.latest && j.latest !== CONFIG.head ? j.latest : null;
      if (newer !== FRESH.latest) { FRESH.latest = newer; renderFresh(); }
    }).catch(() => {});
  }
  function reloadHere() {
    const v = state.view;
    const r = { tab: state.tab, kind: v.kind, path: v.path || null, chain: v.kind === 'chain' && M().chains[v.id] ? M().chains[v.id].name : null, from: CONFIG.head || null, lens: state.lens ? { ...state.lens } : null };
    try { sessionStorage.setItem(RESUME, JSON.stringify(r)); } catch (e) { /* storage unavailable */ }
    // The last marks get there first (a big review's are too big to finish after the page is gone).
    Promise.race([flushSave(true), new Promise((done) => setTimeout(done, 2000))]).then(() => location.reload());
  }
  function renderFresh() {
    const el = $('#vw-fresh');
    if (!el) return;
    const short = (h) => esc(String(h || '').slice(0, 7));
    const step = FRESH.steps.filter((x) => x.state === 'running').map((x) => x.label + (x.detail ? ': ' + x.detail : '')).pop();
    let h = '';
    if (FRESH.moved) h = `<span>untangle now reviews <code>${short(FRESH.moved)}</code>; this page shows <code>${short(CONFIG.head)}</code>.</span><button type="button" class="btn xs primary" data-act="reload">Reload</button>`;
    else if (FRESH.state === 'checking') h = '<span class="spin" aria-hidden="true"></span><span>Looking for new commits…</span>';
    else if (FRESH.state === 'building') h = `<span class="spin" aria-hidden="true"></span><span>Updating to <code>${short(FRESH.head)}</code>${step ? ` · ${esc(step)}` : ''}…</span>`;
    else if (FRESH.state === 'failed') h = `<span class="d">Couldn’t update: ${esc(FRESH.error || 'unknown error')}</span><button type="button" class="btn xs" data-act="refresh">Try again</button>`;
    else if (FRESH.latest) h = `<span>New commits: <code>${short(FRESH.latest)}</code></span><button type="button" class="btn xs primary" data-act="refresh">Refresh</button>`;
    const was = el.hidden;
    el.hidden = !h;
    el.innerHTML = h;
    // It slides down from the top bar.
    if (was && h && moving()) el.animate([{ transform: 'translateY(-8px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 280, easing: EASE });
  }

  // ---------- Jump to (Ctrl K): a chain, file, symbol or thread by name, or a search. What's typed
  // narrows the list, Tab narrows it to one kind, ↑ ↓ choose and Enter opens.
  const PAL = { open: false, q: '', scope: 'all', items: [], active: 0, sym: new Map(), symTimer: null, el: null, input: null, list: null, scopeBtn: null };
  const SCOPES = ['all', 'chains', 'files', 'symbols', 'threads'];
  const SCOPE_WORD = { all: 'Everything', chains: 'Chains', files: 'Files', symbols: 'Symbols', threads: 'Threads' };
  // How well a name matches what's typed (lower case): the letters in order, better together and
  // at the start of words. Null when they aren't all there.
  function fuzzy(text, q) {
    if (!q) return { score: 0, at: [] };
    const t = text.toLowerCase();
    const wordStart = (k) => k === 0 || /[^A-Za-z0-9]/.test(text[k - 1]) || (/[a-z]/.test(text[k - 1]) && /[A-Z]/.test(text[k]));
    const i = t.indexOf(q);
    if (i >= 0) return { score: 1000 - i - text.length / 2 + (wordStart(i) ? 200 : 0), at: Array.from({ length: q.length }, (_, k) => i + k) };
    const at = [];
    let score = 500 - text.length / 2;
    for (let j = 0, k = 0; j < t.length && k < q.length; j++) {
      if (t[j] !== q[k]) continue;
      score += (wordStart(j) ? 15 : 0) + (at.length && at[at.length - 1] === j - 1 ? 5 : -3);
      at.push(j);
      k++;
    }
    // Letters spread over a long name match by chance.
    if (at.length !== q.length || at[at.length - 1] - at[0] > Math.max(q.length * 3, q.length + 8)) return null;
    return { score: score - (at[at.length - 1] - at[0]), at };
  }
  // Text with the matched letters (positions `at`, counted from `from`) marked.
  function matched(text, at, from) {
    const set = new Set(at.map((x) => x - (from || 0)));
    let out = '';
    for (let k = 0; k < text.length; k++) out += set.has(k) ? `<em>${esc(text[k])}</em>` : esc(text[k]);
    return out.replace(/<\/em><em>/g, '');
  }
  const SYMBOL_ICON = { 5: 'symbolClass', 10: 'symbolEnum', 11: 'symbolInterface', 23: 'symbolClass', 8: 'symbolField', 7: 'symbolField', 13: 'symbolVariable', 14: 'symbolVariable', 22: 'symbolEnum' };
  const goView = (v, tab) => () => { state.view = v; state.peek = null; state.focus = null; if (tab) state.tab = tab; render({ top: true }); };
  function palCandidates(q) {
    const m = M(), out = { chains: [], files: [], symbols: [], threads: [] };
    const on = (k) => PAL.scope === 'all' || PAL.scope === k;
    if (on('chains')) {
      m.chains.forEach((c) => {
        const r = fuzzy(c.name, q);
        if (!r) return;
        const st = stats(blocksOf(c.blocks)), n = splitName(c.name);
        out.chains.push({ score: r.score + (st.open ? 40 : 0) - c.depth, icon: ICON.chain, html: (n.own ? `<span class="own">${matched(n.own, r.at)}</span>` : '') + matched(n.name, r.at, n.own.length), hint: st.open ? `${st.open} to review` : 'reviewed', go: goView({ kind: 'chain', id: c.id }, 'chains') });
      });
      [['Chain map', { kind: 'map', family: null }, ICON.map], ['Not in a chain', { kind: 'standalone' }, ICON.chain]].forEach(([label, v, icon]) => {
        const r = q && fuzzy(label, q);
        if (r) out.chains.push({ score: r.score - 100, icon, ui: true, html: matched(label, r.at), hint: '', go: goView(v, 'chains') });
      });
    }
    if (on('files')) {
      const add = (f, gen) => {
        const r = fuzzy(f.p, q);
        if (!r) return;
        const i = f.p.lastIndexOf('/') + 1;
        const st = gen ? null : stats(f.blocks);
        // A match in the file's name counts more than one in its folders.
        out.files.push({ score: r.score + (r.at.length && r.at[0] >= i ? 300 : 0) + (st && st.open ? 40 : 0) - (gen ? 200 : 0), icon: ICON.file, html: `<span class="dir">${matched(f.p.slice(0, i), r.at)}</span><span class="fn">${matched(f.p.slice(i), r.at, i)}</span>`, hint: gen ? 'generated' : st.open ? `${st.open} to review` : 'reviewed', go: () => openFile(f.p) });
      };
      m.files.forEach((f) => add(f, false));
      m.generated.forEach((f) => add(f, true));
    }
    if (on('symbols') && CONFIG.served && q.length >= 2) {
      let known = null;
      for (let i = q.length; i >= 2 && !known; i--) { const e = PAL.sym.get(q.slice(0, i)); if (e && e.status === 'ok') known = e; }
      (known ? known.list : []).forEach((x) => {
        const r = fuzzy(x.name, q);
        if (!r) return;
        out.symbols.push({ score: r.score + (M().files.some((f) => f.p === x.p) ? 150 : 0), icon: ICON[SYMBOL_ICON[x.kind] || 'symbol'], html: (x.container ? `<span class="own">${esc(x.container)}.</span>` : '') + matched(x.name, r.at), hint: `${fileName(x.p)}:${x.l}`, go: () => openSource({ side: 'head', p: x.p, line: x.l }) });
      });
    }
    if (on('threads') && GH.on && GH.data) {
      GH.data.threads.forEach((t) => {
        const c = t.comments[0];
        const where = `${fileName(t.path)}:${t.file ? 'file' : t.at != null ? t.at : t.originalLine}`;
        const text = c ? c.body.replace(/```[\s\S]*?```/g, '[code]').replace(/[#>*_`]/g, '').replace(/\s+/g, ' ').trim() : '';
        const label = `${where} ${trunc(text, 70)}`;
        const r = fuzzy(label, q) || (c && fuzzy(c.author.login, q) ? { score: 400, at: [] } : null);
        if (!r) return;
        out.threads.push({ score: r.score + (t.resolved ? -100 : 50), icon: ICON.comment, html: matched(where, r.at) + `<span class="own">${matched(label.slice(where.length), r.at, where.length)}</span>`, hint: `${c ? c.author.login : ''}${t.resolved ? ' · resolved' : ''}`, go: () => openThread(t.id) });
      });
    }
    if (on('threads') && NT.data) {
      NT.data.notes.forEach((n) => {
        const where = `N${n.n} ${fileName(n.path)}:${n.file ? 'file' : n.line}`;
        const text = n.comments[0].body.replace(/```[\s\S]*?```/g, '[code]').replace(/[#>*_`]/g, '').replace(/\s+/g, ' ').trim();
        const label = `${where} ${trunc(text, 70)}`;
        const r = fuzzy(label, q);
        if (!r) return;
        out.threads.push({ score: r.score + (n.resolved ? -100 : 60), icon: ICON.comment, html: matched(where, r.at) + `<span class="own">${matched(label.slice(where.length), r.at, where.length)}</span>`, hint: `note${n.resolved ? ' · resolved' : ''}`, go: () => openNote(n.n) });
      });
    }
    return out;
  }
  function palSymbols(q) {
    if (PAL.sym.has(q)) return;
    clearTimeout(PAL.symTimer);
    PAL.symTimer = setTimeout(() => {
      if (PAL.sym.has(q)) return;
      const entry = { status: 'loading', list: [] };
      PAL.sym.set(q, entry);
      api('symbols?q=' + encodeURIComponent(q)).then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.status); return j; }))
        .then((j) => { entry.status = 'ok'; entry.list = j.symbols || []; })
        .catch((e) => { entry.status = 'error'; entry.error = e.message; })
        .then(() => { if (PAL.open && PAL.q.trim().toLowerCase().startsWith(q)) palDraw(); });
    }, 160);
  }
  function palDraw() {
    const q = PAL.q.trim().toLowerCase();
    PAL.scopeBtn.textContent = SCOPE_WORD[PAL.scope];
    const scopes = PAL.el.querySelector('.pal-scopes');
    if (scopes) scopes.innerHTML = SCOPES.filter((k) => (k !== 'symbols' || CONFIG.served) && (k !== 'threads' || GH.on || NT.on)).map((k) => `<button type="button" class="chip-btn${PAL.scope === k ? ' on' : ''}" data-scope-to="${k}" aria-pressed="${PAL.scope === k}">${SCOPE_WORD[k]}</button>`).join('');
    const symOn = CONFIG.served && (PAL.scope === 'all' || PAL.scope === 'symbols');
    if (symOn && q.length >= 2) palSymbols(q);
    const c = palCandidates(q);
    const all = PAL.scope === 'all';
    const lim = all ? { chains: q ? 5 : 6, files: q ? 5 : 4, symbols: 6, threads: 4 } : { chains: 100, files: 100, symbols: 100, threads: 100 };
    const items = [];
    let h = '';
    const row = (it) => { const i = items.push(it) - 1; return `<div class="pal-r" role="option" id="pal-${i}" data-pi="${i}" aria-selected="false"><span class="ic">${it.icon}</span><span class="nm${it.ui ? ' ui' : ''}">${it.html}</span><span class="hint">${esc(it.hint || '')}</span></div>`; };
    [['chains', 'Chains'], ['files', 'Files'], ['symbols', 'Symbols, from the language server'], ['threads', 'Threads']].forEach(([k, label]) => {
      const list = c[k].sort((x, y) => y.score - x.score).slice(0, lim[k]);
      const e = k === 'symbols' && symOn && q.length >= 2 ? PAL.sym.get(q) : null;
      const note = k === 'symbols' && symOn && (all ? q.length >= 2 : true) && !list.length
        ? (q.length < 2 ? 'Type two letters or more.' : !e || e.status === 'loading' ? (lspState === 'ready' ? 'Asking the language server…' : 'Starting the language server: its first answer can take a minute…') : e.status === 'error' ? esc(e.error) : '') : '';
      if (!list.length && !note) return;
      h += `<div class="pal-g">${label}</div>` + list.map(row).join('') + (note ? `<div class="pal-wait">${note}</div>` : '');
    });
    if (q && all) {
      h += '<div class="pal-g">Search</div>' + row({ icon: ICON.search, ui: true, html: `Changed lines with “${esc(PAL.q.trim())}”`, hint: '', go: () => search(PAL.q.trim(), state.search.scope.startsWith('repo-') ? 'unreviewed' : state.search.scope) });
      if (CONFIG.served) h += row({ icon: ICON.search, ui: true, html: `The repository, for “${esc(PAL.q.trim())}”`, hint: 'every file', go: () => search(PAL.q.trim(), 'repo-head') });
    }
    if (!items.length) h += `<div class="pal-wait">${q ? `Nothing matches “${esc(PAL.q.trim())}”.` : 'Nothing here yet.'}</div>`;
    PAL.items = items;
    PAL.active = Math.min(PAL.active, Math.max(0, items.length - 1));
    PAL.list.innerHTML = h;
    palMark();
  }
  function palMark() {
    PAL.list.querySelectorAll('.pal-r').forEach((r) => {
      const on = Number(r.dataset.pi) === PAL.active;
      r.classList.toggle('on', on);
      r.setAttribute('aria-selected', String(on));
      if (on) r.scrollIntoView({ block: 'nearest' });
    });
    PAL.input.setAttribute('aria-activedescendant', PAL.items.length ? 'pal-' + PAL.active : '');
  }
  function palScope(step) {
    const usable = SCOPES.filter((k) => (k !== 'symbols' || CONFIG.served) && (k !== 'threads' || GH.on || NT.on));
    PAL.scope = usable[(usable.indexOf(PAL.scope) + step + usable.length) % usable.length];
    PAL.active = 0;
    palDraw();
  }
  function palGo(i) {
    const it = PAL.items[i];
    if (!it) return;
    palClose();
    it.go();
  }
  function search(q, scope) {
    state.search = { q, scope };
    if (state.view.kind !== 'search') state.prevView = state.view;
    state.view = { kind: 'search' };
    state.peek = null;
    render({ top: true });
  }
  function palOpen(q) {
    if (!PAL.el) {
      const el = document.createElement('div');
      el.className = 'pal';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'Jump to');
      el.hidden = true;
      el.innerHTML = `<div class="pal-in"><button type="button" class="ib pal-back" title="Close" aria-label="Close">${ICON.back}</button>${ICON.search}<input type="text" placeholder="Jump to a chain, file, symbol or thread" aria-label="Jump to" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list"><button type="button" class="pal-scope" title="Only chains, files, symbols or threads (Tab)"></button></div>`
        + `<div class="pal-scopes" role="group" aria-label="Look in"></div><div class="pal-list" id="pal-list" role="listbox" aria-label="Results"></div><div class="pal-f"><span><kbd>↑</kbd><kbd>↓</kbd>choose</span><span><kbd>Enter</kbd>open</span><span><kbd>Tab</kbd>only chains, files, symbols or threads</span><span><kbd>Esc</kbd>close</span></div>`;
      viewer.appendChild(el);
      Object.assign(PAL, { el, input: el.querySelector('input'), list: el.querySelector('.pal-list'), scopeBtn: el.querySelector('.pal-scope') });
      PAL.input.addEventListener('input', () => { PAL.q = PAL.input.value; PAL.active = 0; palDraw(); });
      PAL.input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (PAL.items.length) { PAL.active = (PAL.active + (e.key === 'ArrowDown' ? 1 : -1) + PAL.items.length) % PAL.items.length; palMark(); }
        } else if (e.key === 'Enter') { e.preventDefault(); palGo(PAL.active); }
        else if (e.key === 'Tab') { e.preventDefault(); palScope(e.shiftKey ? -1 : 1); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); palClose(); }
      });
      PAL.scopeBtn.addEventListener('click', () => { palScope(1); PAL.input.focus(); });
      el.querySelector('.pal-back').addEventListener('click', palClose);
      el.querySelector('.pal-scopes').addEventListener('click', (e) => { const b = e.target.closest('[data-scope-to]'); if (b) { PAL.scope = b.dataset.scopeTo; PAL.active = 0; palDraw(); } });
      PAL.list.addEventListener('mousemove', (e) => { const r = e.target.closest('[data-pi]'); if (r && Number(r.dataset.pi) !== PAL.active) { PAL.active = Number(r.dataset.pi); palMark(); } });
      PAL.list.addEventListener('click', (e) => { const r = e.target.closest('[data-pi]'); if (r) palGo(Number(r.dataset.pi)); });
    }
    closeMenu();
    if (keysEl && !keysEl.hidden) toggleKeys(false);
    PAL.open = true;
    PAL.el.hidden = false;
    scrim('pal');
    PAL.input.value = q != null ? q : PAL.q;
    PAL.q = PAL.input.value;
    PAL.active = 0;
    palDraw();
    PAL.input.focus();
    PAL.input.select();
    layerSoon();
  }
  function palClose() {
    if (!PAL.open) return;
    PAL.open = false;
    PAL.el.hidden = true;
    scrim(null);
    layerSoon();
  }

  // ---------- events
  // A comment's text, or why it can't be sent yet.
  const bodyOf = (key) => { const b = (drafts.get(key) || '').trim(); if (!b) { GH.errors.set(key, 'Write something first.'); NT.errors.set(key, 'Write something first.'); render(); } return b; };
  // Whether a composer may close: an unsent comment is only dropped when the user says so.
  const letGo = (key, original) => { const t = drafts.get(key) || ''; if (t.trim() && t !== original && !confirm('Discard this unsent comment?')) return false; setDraft(key, ''); GH.preview.delete(key); GH.errors.delete(key); NT.errors.delete(key); return true; };
  const findComment = (id) => { const d = GH.data; if (!d) return null; for (const t of d.threads) { const c = t.comments.find((x) => x.id === id); if (c) return c; } return d.comments.find((x) => x.id === id) || (d.pr.id === id ? d.pr : null); };
  const GH_ACTS = new Set(['conversation', 'thread-open', 'thread-toggle', 'resolved-toggle', 'away-toggle', 'review-toggle', 'file-comment', 'file-cancel', 'compose-cancel', 'reply-open', 'reply-cancel', 'edit-open', 'edit-cancel', 'cmp-pane', 'cmp-suggest', 'react-open']);
  function ghClick(act, d) {
    if (act === 'conversation') { state.view = { kind: 'conversation' }; state.peek = null; return render({ top: true }); }
    if (act === 'gh-refresh') return ghLoad(false);
    if (act === 'thread-open') return openThread(d.thread);
    if (act === 'thread-toggle') { GH.opened.has(d.thread) ? GH.opened.delete(d.thread) : GH.opened.add(d.thread); return render(); }
    if (act === 'resolved-toggle') { GH.showResolved = !GH.showResolved; return renderSide(); }
    if (act === 'away-toggle') { GH.away.has(d.p) ? GH.away.delete(d.p) : GH.away.add(d.p); hint({ away: { act, p: d.p } }); return render(); }
    if (act === 'review-toggle') { GH.reviewOpen = !GH.reviewOpen; if (GH.reviewOpen) GH.focus = 'review'; return render(); }
    if (act === 'file-comment') { GH.fileCompose = d.p; GH.focus = 'file:' + d.p; return render(); }
    if (act === 'file-cancel') { if (letGo(d.key)) { GH.fileCompose = null; render(); } return; }
    if (act === 'compose-cancel') { if (letGo(d.key)) { state.compose = null; render(); } return; }
    if (act === 'reply-open') { GH.replying.add(d.thread); GH.focus = 'reply:' + d.thread; return render(); }
    if (act === 'reply-cancel') { if (letGo(d.key)) { GH.replying.delete(d.key.slice('reply:'.length)); render(); } return; }
    if (act === 'edit-open') {
      const c = findComment(d.id);
      if (!c) return;
      GH.editing = d.id;
      if (!drafts.has('edit:' + d.id)) setDraft('edit:' + d.id, c.body);
      GH.focus = 'edit:' + d.id;
      return render();
    }
    if (act === 'edit-cancel') { const c = findComment(d.key.slice('edit:'.length)); if (letGo(d.key, c && c.body)) { GH.editing = null; render(); } return; }
    if (act === 'cmp-pane') {
      if (d.pane === 'preview') { GH.preview.add(d.key); if (!d.local) ghPreview(d.key); } else { GH.preview.delete(d.key); GH.focus = d.key; }
      return render();
    }
    if (act === 'cmp-suggest') {
      const c = state.compose;
      if (!c || c.key !== d.key) return;
      const block = '```suggestion\n' + suggestionLines(c).join('\n') + '\n```\n';
      const now = drafts.get(d.key) || '';
      setDraft(d.key, now + (now && !now.endsWith('\n') ? '\n' : '') + block);
      GH.preview.delete(d.key);
      GH.focus = d.key;
      return render();
    }
    if (act === 'react-open') { GH.picker = GH.picker === d.subject ? null : d.subject; return render(); }
    if (act === 'gh-react') {
      // At once on the page; GitHub's answer follows.
      const c = findComment(d.subject), on = d.on === 'true';
      if (c) {
        const r = c.reactions.find((x) => x.content === d.content);
        if (r) { r.count += on ? 1 : -1; r.mine = on; if (!r.count) c.reactions.splice(c.reactions.indexOf(r), 1); } else if (on) c.reactions.push({ content: d.content, count: 1, mine: true });
      }
      GH.picker = null;
      return ghAct('react:' + d.subject, { action: 'react', subject: d.subject, content: d.content, on });
    }
    if (act === 'gh-thread') {
      const body = bodyOf(d.key);
      if (!body) return;
      const c = state.compose;
      if (!d.file && !c) return;
      const draft = d.file ? { path: GH.fileCompose, body } : { path: c.path, body, line: c.line, side: c.side, startLine: c.startLine != null ? c.startLine : undefined, startSide: c.startSide || undefined };
      return ghAct(d.key, { action: 'thread', mode: d.mode, draft }, () => {
        setDraft(d.key, ''); GH.preview.delete(d.key);
        if (d.file) GH.fileCompose = null; else state.compose = null;
        toast(d.mode === 'single' ? 'Comment posted' : 'Added to your pending review');
      });
    }
    if (act === 'gh-reply') {
      const body = bodyOf(d.key);
      if (!body) return;
      return ghAct(d.key, { action: 'reply', mode: d.mode, thread: d.thread, body }, () => { setDraft(d.key, ''); GH.preview.delete(d.key); GH.replying.delete(d.thread); toast(d.mode === 'single' ? 'Reply posted' : 'Reply added to your pending review'); });
    }
    if (act === 'gh-edit') {
      const body = bodyOf(d.key);
      if (!body) return;
      return ghAct(d.key, { action: 'edit', kind: d.kind, id: d.id, body }, () => { setDraft(d.key, ''); GH.preview.delete(d.key); GH.editing = null; });
    }
    if (act === 'gh-delete') {
      if (!confirm('Delete this comment on GitHub?')) return;
      return ghAct('del:' + d.id, { action: 'delete', kind: d.kind, id: d.id }, () => toast('Comment deleted'));
    }
    if (act === 'gh-resolve') return ghAct('resolve:' + d.thread, { action: 'resolve', thread: d.thread, resolved: d.on === 'true' }, () => GH.opened.delete(d.thread));
    if (act === 'gh-comment') {
      const body = bodyOf('issue');
      if (!body) return;
      return ghAct('issue', { action: 'comment', body }, () => { setDraft('issue', ''); GH.preview.delete('issue'); toast('Comment posted'); });
    }
    if (act === 'gh-submit') {
      const body = (drafts.get('review') || '').trim();
      return ghAct('review', { action: 'submit', event: GH.event, body }, () => { setDraft('review', ''); GH.preview.delete('review'); GH.reviewOpen = false; toast({ APPROVE: 'Approved', REQUEST_CHANGES: 'Changes requested', COMMENT: 'Review submitted' }[GH.event]); });
    }
    if (act === 'gh-discard') {
      const n = GH.data && GH.data.pending ? GH.data.pending.comments : 0;
      if (!confirm(`Discard your pending review${n ? ` and its ${n} comment${n === 1 ? '' : 's'}` : ''}? This can’t be undone.`)) return;
      return ghAct('review', { action: 'discard' }, () => { GH.reviewOpen = false; toast('Pending review discarded'); });
    }
  }
  // A note's lines, from the comment being written: on one side. A range across both sides (a
  // removed line to an added one) keeps the lines of the side it ends on.
  function noteDraft(c) {
    if (c.startLine == null || c.startSide === c.side) return { path: c.path, side: c.side, line: c.line, startLine: c.startLine != null ? c.startLine : undefined };
    const f = M().files.find((x) => x.p === c.path);
    const h = f && c.hi != null ? f.hunks[c.hi] : null;
    const nums = [];
    if (h) for (let i = c.r0; i <= c.r1; i++) { const r = h.meta[i]; const v = c.side === 'LEFT' ? (r.t !== '+' ? r.o : null) : (r.t !== '-' ? r.n : null); if (v != null) nums.push(v); }
    return { path: c.path, side: c.side, line: c.line, startLine: nums.length > 1 ? Math.min(...nums) : undefined };
  }
  // What a note just written does: kept, and sent to the watching agent or held.
  function noteSaved(what) {
    const a = agentFirst();
    if (NT.data && !NT.data.live) return `${what || 'Note'} saved, held until you send it`;
    if (!a) return `${what || 'Note'} saved`;
    // Nothing listens in its chat: its menu opens, with what's left (Wake, in Orca).
    if (a.state === 'deaf' || a.state === 'left') { NT.agentOpen = a.name; return `${what || 'Note'} saved. ${agentLabel(a)}`; }
    return `${what || 'Note'} saved, ${a.state === 'queued' ? 'queued' : 'sent'} to ${a.name}`;
  }
  function ntCopied(ns) {
    api('notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'copied', ns }) }).then(okJson).then((j) => { ntSet(j); render(); }).catch(() => {});
  }
  // A note, from the Threads tab or Ctrl K: its file, opened at its lines, and the note pulsing
  // (unfolded, if it's resolved).
  function openNote(n) {
    const note = NT.byN.get(n);
    if (!note) return;
    if (note.resolved) NT.opened.add(n);
    state.peek = null;
    if (!M().files.some((f) => f.p === note.path) && !M().generated.some((f) => f.p === note.path)) return toast(`${note.path} isn’t in this review`);
    state.view = { kind: 'file', path: note.path };
    const r = !note.file && note.line != null ? rowAt(note.path, note.side, note.line) : null;
    if (r) { const k = 'file|' + note.path + '#' + r.hi + ':0'; state.collapsed.delete(k); state.expanded.add(k); } else NT.folded.delete(note.path);
    NT.reveal = n;
    render({ top: true });
  }
  // Notes: where comments go, writing and answering notes, and the two ways out (copy, post).
  function ntClick(act, d) {
    const n = d.n != null ? Number(d.n) : null, note = n != null ? NT.byN.get(n) : null;
    if (act === 'nt-mode') {
      if (!NT.data || d.mode === (localMode() ? 'local' : 'github')) return;
      // From a box, its text keeps the focus.
      if (d.key) GH.focus = d.key;
      return ntSettings({ mode: d.mode });
    }
    if (act === 'nt-add') {
      const c = state.compose;
      if (!d.file && !c) return;
      const body = bodyOf(d.key);
      if (!body) return;
      const at = d.file ? { path: GH.fileCompose, file: true } : noteDraft(c);
      return ntAct(d.key, { action: 'add', body, ...at }, () => {
        setDraft(d.key, ''); GH.preview.delete(d.key);
        if (d.file) GH.fileCompose = null; else state.compose = null;
        toast(noteSaved());
      });
    }
    if (act === 'nt-quote') {
      // A reply to a GitHub thread, in local mode: a note on its lines that quotes it.
      const t = GH.data && GH.data.threads.find((x) => x.id === d.thread);
      if (!t) return;
      const body = bodyOf(d.key);
      if (!body) return;
      const c0 = t.comments[0];
      const at = t.file || t.at == null ? { path: t.path, file: true } : { path: t.path, side: t.side, line: t.at, startLine: t.from != null && t.from !== t.at ? t.from : undefined };
      return ntAct(d.key, { action: 'add', body, ...at, quote: { thread: t.id, author: c0 ? c0.author.login : '', body: c0 ? c0.body : '', url: c0 ? c0.url : '' } }, () => {
        setDraft(d.key, ''); GH.preview.delete(d.key); GH.replying.delete(t.id);
        toast(noteSaved());
      });
    }
    if (act === 'nt-reply-open') { NT.replying.add(n); GH.focus = 'nreply:' + n; return render(); }
    if (act === 'nt-reply-cancel') { if (letGo(d.key)) { NT.replying.delete(Number(d.key.slice('nreply:'.length))); render(); } return; }
    if (act === 'nt-reply') {
      const body = bodyOf(d.key);
      if (!body) return;
      return ntAct(d.key, { action: 'reply', n, body }, () => { setDraft(d.key, ''); GH.preview.delete(d.key); NT.replying.delete(n); toast(noteSaved('Reply')); });
    }
    if (act === 'nt-edit-open') {
      const c = note && note.comments.find((x) => x.id === d.id);
      if (!c) return;
      NT.editing = n + ':' + d.id;
      if (!drafts.has('nedit:' + NT.editing)) setDraft('nedit:' + NT.editing, c.body);
      GH.focus = 'nedit:' + NT.editing;
      return render();
    }
    if (act === 'nt-edit-cancel') {
      const [nn, id] = d.key.slice('nedit:'.length).split(':');
      const owner = NT.byN.get(Number(nn)), c = owner && owner.comments.find((x) => x.id === id);
      if (letGo(d.key, c && c.body)) { NT.editing = null; render(); }
      return;
    }
    if (act === 'nt-edit') {
      const body = bodyOf(d.key);
      if (!body) return;
      return ntAct(d.key, { action: 'edit', n, id: d.id, body }, () => { setDraft(d.key, ''); GH.preview.delete(d.key); NT.editing = null; });
    }
    if (act === 'nt-delete') {
      if (!note) return;
      const lead = note.comments[0].id === d.id, more = note.comments.length - 1;
      if (!confirm(lead ? `Delete N${n}${more ? ` and its ${more} repl${more === 1 ? 'y' : 'ies'}` : ''}? This can’t be undone.` : 'Delete this reply?')) return;
      return ntAct('del:' + n + ':' + d.id, { action: 'delete', n, id: lead ? undefined : d.id }, () => toast(lead ? `N${n} deleted` : 'Reply deleted'));
    }
    if (act === 'nt-resolve') { if (note) ntAct('res:' + n, { action: 'resolve', n, resolved: !note.resolved }, () => NT.opened.delete(n)); return; }
    if (act === 'nt-fold') { NT.opened.has(n) ? NT.opened.delete(n) : NT.opened.add(n); return render(); }
    if (act === 'nt-was') { NT.was.has(n) ? NT.was.delete(n) : NT.was.add(n); return render(); }
    if (act === 'nt-away') { NT.folded.has(d.p) ? NT.folded.delete(d.p) : NT.folded.add(d.p); hint({ away: { act, p: d.p } }); return render(); }
    if (act === 'nt-resolved-toggle') { NT.showResolved = !NT.showResolved; return renderSide(); }
    if (act === 'nt-open') return openNote(n);
    if (act === 'nt-copy1') {
      if (note) copyText(ntExport([note]), `N${n} copied for your agent`).then((ok) => { if (ok && !note.copied) ntCopied([n]); });
      return;
    }
    if (act === 'nt-copy-text') {
      const i = note ? note.comments.findIndex((x) => x.id === d.id) : -1;
      if (i >= 0) copyText(note.comments[i].body, `${note.comments[i].by}’s ${i ? 'reply' : `note, N${n},`} copied`);
      return;
    }
    if (act === 'nt-copy') {
      const list = ntScoped(NT.data ? NT.data.scope : 'open');
      if (list.length) copyText(ntExport(list), `${list.length} note${list.length === 1 ? '' : 's'} copied for your agent`).then((ok) => { if (ok) ntCopied(list.map((x) => x.n)); });
      return;
    }
    if (act === 'nt-post' || act === 'nt-post1') {
      const list = act === 'nt-post1' ? (note ? [note] : []) : NT.data.notes.filter((x) => !x.resolved && !x.gone && x.comments[0].by == null);
      if (!list.length) return;
      if (act === 'nt-post' && !confirm(`Post your ${list.length} open note${list.length === 1 ? '' : 's'} to GitHub? ${list.length === 1 ? 'It becomes a thread' : 'Each becomes a thread'} of your pending review, and leaves the notes.`)) return;
      return ntAct(act === 'nt-post' ? 'post' : 'post:' + n, { action: 'post', ns: list.map((x) => x.n) }, () => toast(`${list.length === 1 ? `N${list[0].n} is` : `${list.length} notes are`} in your pending review on GitHub`));
    }
    if (act === 'nt-send') {
      const k = NT.data ? NT.data.held : 0, a = agentFirst();
      return ntAct('send', { action: 'send' }, () => toast(`${k} held comment${k === 1 ? '' : 's'} sent${a ? ` to ${a.name}` : ''}`));
    }
    if (act === 'nt-agent') { NT.agentOpen = NT.agentOpen === d.agent ? null : d.agent; return renderAgent(); }
    if (act === 'nt-wake') {
      // untangle types the line into the agent's chat, in Orca, as if you had.
      const key = 'wake:' + d.agent;
      if (NT.busy) return;
      NT.busy = key;
      NT.errors.delete(key);
      renderAgent();
      api('notes/wake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: d.agent }) }).then(okJson)
        .then((j) => { NT.agentOpen = null; ntSet(j); toast(`Typed into ${d.agent}’s chat`); })
        .catch((e) => { NT.errors.set(key, e.message); ntLoad(); })
        .then(() => { NT.busy = null; render(); });
      return;
    }
  }
  // The review's popover closes on a click outside it (what's typed in it stays as a draft).
  document.addEventListener('click', (e) => { if (GH.reviewOpen && !e.target.closest('.vw-review, [data-act="review-toggle"]') && document.contains(e.target)) { GH.reviewOpen = false; render(); } });
  // So does an agent's menu.
  document.addEventListener('click', (e) => { if (NT.agentOpen && !e.target.closest('.vw-agent-w') && document.contains(e.target)) { NT.agentOpen = null; renderAgent(); } });
  // A press on a box's switch leaves the focus, and the caret, where you're writing.
  viewer.addEventListener('mousedown', (e) => { if (e.target.closest && e.target.closest('.cmp-mode button')) e.preventDefault(); });
  viewer.addEventListener('input', (e) => {
    if (e.target.matches && e.target.matches('.cmp-ta, .rv-ta')) fitBox(e.target);
    const k = e.target.dataset && e.target.dataset.draft;
    // @ and # come from GitHub: not for notes.
    if (k != null) { setDraft(k, e.target.value); if (GH.on && !/^n(reply|edit):/.test(k) && !(localMode() && /^(new|file|reply):/.test(k))) mentionUpdate(e.target); }
    if (e.target.matches && e.target.matches('[data-nt-opening]')) {
      NT.opening = e.target.value;
      clearTimeout(NT.openingTimer);
      NT.openingTimer = setTimeout(() => { NT.openingTimer = null; ntSettings({ opening: NT.opening }); }, 600);
    }
  });
  viewer.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act],[data-open],[data-group],[data-chain],[data-standalone],[data-node],[data-graph-open],[data-map],[data-tab],[data-compare],[data-dir],[data-usage],[data-scope],[data-commit],[data-detail],.ref');
    if (t && t.closest('.menu') && t.dataset.act !== 'crumb-dir' && t.dataset.act !== 'code-size') closeMenu();
    if (t && t.tagName === 'A') return;
    if (!t || !viewer.contains(t)) return;
    const m = M();
    const d = t.dataset;
    if (d.act === 'menu') return toggleMenu(d.menu);
    if (d.act === 'crumb-dir') {
      const was = crumbDir(), to = d.folder;
      MENU.crumb = to;
      MENU.html = '';
      renderMenu();
      MENU.el.scrollTop = 0;
      // Up, the folder it came from takes the focus; down, what leads to the file open, else the first.
      const items = [...MENU.el.querySelectorAll('.mi:not([data-up])')];
      const up = !to || was.startsWith(to + '/');
      const back = up && items.find((x) => x.dataset.folder != null && ((was + '/').startsWith(x.dataset.folder + '/') || (x.dataset.folder + '/').startsWith(was + '/')));
      menuFocus(back || items.find((x) => x.getAttribute('aria-current') === 'true') || items[0] || MENU.el.querySelector('.mi'));
      return;
    }
    if (d.compare) {
      if (state.compare === d.compare) return;
      state.compare = d.compare; state.peek = null; state.lens = null; lensMemo = null;
      state.view = { kind: 'map', family: null }; state.focus = null;
      return render({ top: true });
    }
    if (d.dir !== undefined && !d.act) {
      state.closedDirs.has(d.dir) ? state.closedDirs.delete(d.dir) : state.closedDirs.add(d.dir);
      renderSide();
      const again = [...side.querySelectorAll('[data-dir]')].find((x) => x.dataset.dir === d.dir);
      if (again) again.focus();
      return;
    }
    if (d.tab) { state.tab = d.tab; if (d.tab === 'commits') loadCommits(); return render(); }
    if (d.act === 'file-section') {
      state.fileSections.has(d.section) ? state.fileSections.delete(d.section) : state.fileSections.add(d.section);
      renderSide();
      side.querySelector(`[data-section="${d.section}"]`)?.focus();
      return;
    }
    if (d.scope) { state.search.scope = d.scope; return render({ top: true }); }
    if (d.graphOpen) { state.graphOpen.add(d.graphOpen); return render(); }
    if (d.node !== undefined && !d.act) {
      const node = Number(d.node);
      // Dropped over a file: that chain, at the member.
      const from = t.closest('.gd') && state.gdrop ? state.gdrop.chain : null;
      if (from != null && !(state.view.kind === 'chain' && state.view.id === from)) {
        state.gdrop = null; state.view = { kind: 'chain', id: from }; state.peek = null; state.focus = null; toChains();
        render({ top: true });
        return goNode(node);
      }
      // Shift: only that member's code, leaving the page where it is (the graph stays under the pointer).
      if (e.shiftKey) {
        const same = state.focus && state.focus.chain === state.view.id && state.focus.node === node;
        state.focus = same ? null : { chain: state.view.id, node };
        return render();
      }
      gdClose();
      return goNode(node);
    }
    if (d.map !== undefined && !d.act) { state.view = { kind: 'map', family: d.map === '' ? null : Number(d.map) }; state.peek = null; state.focus = null; return render({ top: true }); }
    // A name with its definition answered ahead, where it's declared: where it's used instead.
    const declared = CONFIG.served && t.classList.contains('ref') && !t.classList.contains('live') && declaredHere(t);
    if (t.classList.contains('ref') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (t.classList.contains('live')) return liveLookup(t, true);
      if (declared) return refUsages(t);
      const old = d.o !== undefined;
      const target = (old ? DEFS_OLD[state.compare] : defsNow()).targets[Number(d.ti)];
      if (target.w === 'repo' && (CONFIG.served || M().files.some((f) => f.p === target.p))) {
        return openSource({ side: old ? 'base' : 'head', p: target.p, line: target.l });
      }
      if (CONFIG.served) return jumpToDefinition({ side: old ? 'base' : 'head', p: d.path, l: Number(old ? d.o : d.n), c: Number(d.col) }, t);
    }
    if (t.classList.contains('live')) return liveLookup(t);
    if (declared) return refUsages(t);
    if (t.classList.contains('ref') && d.o !== undefined) {
      const path = d.path, o = Number(d.o), col = Number(d.col);
      const same = state.peek && state.peek.old && state.peek.path === path && state.peek.o === o && state.peek.col === col;
      state.peek = same ? null : { old: true, path, o, col, ti: Number(d.ti), name: nameOf(t) };
      return render();
    }
    if (t.classList.contains('ref')) {
      const path = d.path, n = Number(d.n), col = Number(d.col);
      const key = `${path}:${n}:${col}`;
      const same = state.peek && state.peek.path === path && state.peek.n === n && state.peek.col === col;
      state.peek = same ? null : { path, n, col, ti: Number(d.ti), usageKey: REFS[state.compare][key] ? key : null, name: nameOf(t) };
      return render();
    }
    if (d.usage && !d.act) {
      const i1 = d.usage.lastIndexOf(':'), i0 = d.usage.lastIndexOf(':', i1 - 1);
      const path = d.usage.slice(0, i0), n = Number(d.usage.slice(i0 + 1, i1)), col = Number(d.usage.slice(i1 + 1));
      const defs = lineDefs(path, n);
      const same = state.peek && state.peek.usageKey === d.usage;
      const hl = M().head.get(path + ':' + n);
      state.peek = same ? null : { path, n, col, ti: defs ? defs.get(col) : undefined, usageKey: d.usage, name: hl ? nameIn(hl.f.hunks[hl.hi].rows[hl.ri][1], col) : '' };
      return render();
    }
    // A commit: its changes become the lens (Shift: the commits from the last one clicked).
    if (d.commit && !d.act) return lensCommit(d.commit, e.shiftKey);
    // A commit in the History view: its details (Shift: the lens, as above).
    if (d.detail && !d.act) {
      if (e.shiftKey) return lensCommit(d.detail, true);
      HX.detail = HX.detail === d.detail ? null : d.detail;
      HX.anchor = HX.index.get(d.detail);
      return render({ reveal: !!HX.detail });
    }
    if (d.chain !== undefined && !d.act) { state.view = { kind: 'chain', id: Number(d.chain) }; state.peek = null; state.focus = null; toChains(); return render({ top: true }); }
    if (d.standalone) { state.view = { kind: 'standalone' }; state.peek = null; return render({ top: true }); }
    if (d.open !== undefined && !d.act) return openFile(d.open, d.line);
    if (d.group !== undefined && !d.act) { state.view = { kind: 'group', id: Number(d.group) }; state.peek = null; return render({ top: true }); }
    const act = d.act;
    if (act === 'jump') return palOpen();
    if (act === 'back') return navBack();
    if (act === 'tests-open') { state.view = { kind: 'tests' }; state.peek = null; state.focus = null; return render({ top: true }); }
    if (act === 'tests-filter') { state.testsFilter = d.v; return render({ top: true }); }
    if (act === 'tests-mode') { UI.testsMode = d.v; saveUI(); return render(); }
    if (act === 'history-open') { state.view = { kind: 'history' }; state.peek = null; state.focus = null; loadCommits(); return render({ top: true }); }
    if (act === 'lens-all') return setLens(null);
    if (act === 'lens-review') { const rv = HX && HX.live && HX.live.review; if (rv) lensSince(rv.head, 'review', d.go === '1'); return; }
    if (act === 'lens-ghost') return lensSince(d.sha, d.why === 'review' ? 'review' : 'push');
    if (act === 'lens-go') return lensGo();
    if (act === 'lens-chain') {
      state.lens = { kind: 'commits', shas: [d.sha] };
      lensMemo = null; navAt = null; HX.anchor = HX.index.get(d.sha);
      state.view = { kind: 'chain', id: Number(d.chainId) }; state.peek = null; state.focus = null;
      return render({ top: true });
    }
    if (act === 'hd-close') { if (state.view.kind === 'chain') state.card = null; else HX.detail = null; return render(); }
    // A parent's details are in History.
    if (act === 'hd-go') {
      if (state.view.kind !== 'history') { state.view = { kind: 'history' }; state.peek = null; state.focus = null; loadCommits(); }
      HX.detail = d.sha; HX.anchor = HX.index.get(d.sha);
      return render({ reveal: true });
    }
    // A chain's commit card opens under its header, which may be scrolled away: it lands in view.
    if (act === 'card') {
      state.card = state.card === d.sha ? null : d.sha;
      if (state.peek && state.peek.history) state.peek = null;
      render();
      const el = state.card && main.querySelector('.hs-detail');
      if (el && el.getBoundingClientRect().top < main.getBoundingClientRect().top + headH()) landAt(el.previousElementSibling || el, headH() + 8);
      return;
    }
    if (act === 'show-commits') {
      state.tab = 'commits';
      loadCommits();
      if (UI.sideOff) toggleSide();
      return render();
    }
    if (act === 'wb-seg') return lensCommit(d.sha, e.shiftKey);
    if (act === 'hd-view') { UI.filesList = d.v === 'list'; saveUI(); return render(); }
    if (act === 'hd-dir') {
      HX.closed.has(d.key) ? HX.closed.delete(d.key) : HX.closed.add(d.key);
      render();
      const again = [...main.querySelectorAll('[data-act="hd-dir"]')].find((x) => x.dataset.key === d.key);
      if (again) again.focus({ preventScroll: true });
      return;
    }
    if (act === 'hd-lens') {
      const cur = state.lens;
      HX.anchor = HX.index.get(d.sha);
      return setLens(cur && cur.kind === 'commits' && cur.shas.length === 1 && cur.shas[0] === d.sha ? null : { kind: 'commits', shas: [d.sha] });
    }
    if (act === 'hd-review') { state.lens = { kind: 'commits', shas: [d.sha] }; lensMemo = null; navAt = null; HX.anchor = HX.index.get(d.sha); return lensGo(); }
    // Read a commit's file in place; the graph, expanded commit and current lens stay put.
    if (act === 'hd-open') {
      const current = state.peek && state.peek.history;
      state.peek = current && current.sha === d.sha && current.path === d.p ? null : { history: { sha: d.sha, path: d.p } };
      render();
      const peek = main.querySelector('.hs-detail .peek');
      if (peek) peek.scrollIntoView({ block: 'nearest' });
      return;
    }
    // A test file's outline, or its diff.
    if (act === 'hd-peek') {
      if (state.peek && state.peek.history) state.peek = { history: { ...state.peek.history, diff: d.mode === 'diff' } };
      return render();
    }
    if (act === 'brought') {
      const sha = d.sha;
      if (HX.open.has(sha)) HX.open.delete(sha);
      else {
        HX.open.add(sha);
        if (!HX.brought.has(sha)) {
          api('brought?sha=' + sha).then((r) => r.json()).then((j) => { HX.brought.set(sha, j.commits ? j : { error: j.error || 'not available' }); render(); })
            .catch((err) => { HX.brought.set(sha, { error: err.message }); render(); });
        }
      }
      return render();
    }
    if (act === 'pill-step') return gotoChange(Number(d.step), true);
    if (act === 'mark-next') return markAndNext();
    if (act === 'comment-here') return commentHere();
    if (act && act.startsWith('pick-')) return pickAct(act);
    if (act === 'graph') {
      // In the page at the top, the click folds it; anywhere else it drops it, kept, or folds it back.
      clearTimeout(GD.enterT); GD.enterT = 0;
      if (gdInPage()) return gdFoldNow();
      if (state.gdrop && state.gdrop.kept) return gdClose();
      return gdOpen(true);
    }
    if (act === 'gd-chain') {
      // A file in several chains: the graph of another one.
      if (!state.gdrop) return;
      state.gdrop.chain = Number(d.chainId);
      const el = main.querySelector('.gd'), tg = gdTarget();
      if (el && tg) { el.innerHTML = gdHtml(tg); gdCenter(el, tg); }
      return;
    }
    if (act === 'ext-peek') {
      const ext = { chain: Number(d.chainId), anchor: d.anchor, i: Number(d.i) };
      const was = state.peek && state.peek.ext;
      state.peek = was && was.chain === ext.chain && was.anchor === ext.anchor && was.i === ext.i ? null : { ext };
      return render();
    }
    if (act === 'ext-box') {
      const c = M().chains[state.view.id], i = Number(d.i), x = c && (c.ext || [])[i];
      if (!x) return;
      const at = c.graph.nodes.findIndex((n) => n.key === x.from[0]);
      state.focus = null;
      state.peek = { ext: { chain: c.id, anchor: at >= 0 ? x.from[0] : 'chain', i } };
      render();
      if (at >= 0) landAt(main.querySelector('#sec-' + at), headH() + 8);
      return;
    }
    if (act === 'ext') {
      const id = Number(d.to), to = M().chains[id];
      if (!to) return;
      const i = to.graph.nodes.findIndex((n) => n.blocks.includes(d.block));
      state.view = { kind: 'chain', id }; state.peek = null; state.focus = null; toChains();
      return render(i >= 0 ? { section: i } : { top: true });
    }
    if (act === 'minimap') { UI.minimap = !UI.minimap; saveUI(); return mini.update(); }
    if (act === 'side-toggle') return toggleSide();
    if (act === 'wrap') { UI.wrap = !wrapOn(); saveUI(); applyCode(); return render(); }
    if (act === 'test-details') { UI.testDetails = !testDetails(); saveUI(); applyCode(); return render(); }
    if (act === 'code-size') { UI.codeSize = Math.min(16, Math.max(10, Math.round(codeSize()) + Number(d.step))); saveUI(); applyCode(); MENU.html = ''; renderMenu(); return render(); }
    if (act === 'shade') { if (SIDE.open) sideDrawer(false); return; }
    if (act === 'threads-fold') {
      const folded = new Set(Array.isArray(UI.foldedThreads) ? UI.foldedThreads : []);
      folded.has(d.key) ? folded.delete(d.key) : folded.add(d.key);
      UI.foldedThreads = [...folded];
      saveUI();
      renderSide();
      const again = side.querySelector(`[data-act="threads-fold"][data-key="${d.key}"]`);
      if (again) again.focus();
      return;
    }
    if (act === 'refresh') return startRefresh();
    if (act === 'rv-open' || act === 'rv-manager' || act === 'rv-new') {
      closeMenu();
      const go = act === 'rv-open' ? api('reviews/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: t.dataset.id }) }) : api('reviews/manager', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ palette: act === 'rv-new' }) });
      go.then((r) => r.json().then((j) => { if (!r.ok) toast(j.error || 'untangle couldn’t open it'); })).catch(() => toast('untangle couldn’t open it'));
      return;
    }
    if (act === 'lsp-restart') {
      t.disabled = true;
      api('lsp/restart', { method: 'POST' }).catch(() => {}).then(pollMetrics);
      return;
    }
    if (act === 'reload') return reloadHere();
    if (act && act.startsWith('nt-')) return ntClick(act, d);
    if (act && (act.startsWith('gh-') || GH_ACTS.has(act))) return ghClick(act, d);
    if (act === 'reset') {
      const n = rev().size;
      if (n && !confirm(`Clear all your review marks (${n} change${n === 1 ? '' : 's'})? This can’t be undone.`)) return;
      state.rev[state.compare] = new Set(); state.blockDiff.clear(); save(); return render();
    }
    if (act === 'close-peek') { state.peek = null; return render(); }
    if (act === 'peek-back') { const prev = state.peek.back.slice(-1)[0]; state.peek = prev; return render(); }
    if (act === 'peek-impl') return showImplementations();
    if (act === 'open-source') return openSource(d);
    if (act === 'open-def') {
      // Ask the server where the peeked name is defined, then open that file whole.
      const p0 = state.peek;
      const params = new URLSearchParams({ side: p0.old ? 'base' : 'head', p: p0.path, l: String(p0.old ? p0.o : p0.n), c: String(p0.col) });
      t.textContent = 'Opening…';
      api('definition?' + params).then((r) => r.json()).then((j) => {
        const x = j.target;
        if (!x) { t.textContent = 'Not found'; return; }
        openSource({ side: x.side || '', p: x.side ? x.p : '', ext: x.ext != null ? x.ext : '', line: x.l, label: x.side ? '' : x.p, where: x.w === 'sdk' ? 'Dart SDK' : x.w === 'package' ? 'package' : '' });
      }).catch(() => { t.textContent = 'Not found'; });
      return;
    }
    if (act === 'open-editor') {
      api('open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ side: d.side || undefined, p: d.p || undefined, ext: d.ext !== '' ? Number(d.ext) : undefined, l: Number(d.line) || 1, c: Number(d.col) || 0 }) })
        .then((r) => r.json()).then((j) => { if (j.error) alert(j.error); }).catch(() => {});
      return;
    }
    if ((act === 'peek-use' || act === 'peek-go') && state.peek && state.peek.uses) {
      const u = (state.peek.uses.list || [])[act === 'peek-go' ? state.peek.sel : Number(d.i)];
      if (!u) return;
      if (act === 'peek-go' || state.peek.sel === Number(d.i)) return openSource({ side: u.side, p: u.side ? u.p : null, ext: u.ext, line: u.l, label: u.p, where: u.w === 'sdk' ? 'Dart SDK' : u.w === 'package' ? 'package' : '' });
      state.peek.sel = Number(d.i);
      return refreshPeek(t, `[data-act="peek-use"][data-i="${d.i}"]`);
    }
    if (act === 'peek-use' || act === 'peek-go') {
      const list = (state.peek && REFS[state.compare][state.peek.usageKey]) || [];
      const i = act === 'peek-go' ? state.peek.sel : Number(d.i);
      if (!list[i]) return;
      if (act === 'peek-go' || state.peek.sel === i) return openFile(list[i][0], list[i][1]);
      state.peek.sel = i;
      return refreshPeek(t, `[data-act="peek-use"][data-i="${i}"]`);
    }
    if (act === 'peek-def') { state.peek.sel = null; return refreshPeek(t, '[data-act="peek-use"]'); }
    if (act === 'clear-focus') { state.focus = null; return render(); }
    if (act === 'toggle-block') { const b = m.blockById.get(d.block); toggleBlocks([b]); hint({ mark: [d.block] }); return render(); }
    if (act === 'toggle-move') { state.moveOpen.has(d.block) ? state.moveOpen.delete(d.block) : state.moveOpen.add(d.block); return render(); }
    if (act === 'move-peek') { state.peek = state.peek && state.peek.moveOf === d.block ? null : { moveOf: d.block }; return render(); }
    if (act === 'toggle-diff') { state.blockDiff.has(d.block) ? state.blockDiff.delete(d.block) : state.blockDiff.add(d.block); hint({ mark: [] }); return render(); }
    if (act === 'toggle-hunk') {
      const btn = t.getAttribute('aria-expanded') === 'true';
      if (btn) { state.collapsed.add(d.key); state.expanded.delete(d.key); } else { state.collapsed.delete(d.key); state.expanded.add(d.key); }
      hint({ mark: [] });
      return render();
    }
    if (act === 'expand-to') { state.collapsed.delete(d.key); state.expanded.add(d.key); return render({ line: Number(d.line) }); }
    if (act === 'more') { const g = { ...grown(d.key) }; g[d.side] += Number(d.n); state.more.set(d.key, g); hint({ more: { key: d.key, side: d.side, n: Number(d.n) } }); return render(); }
    if (act === 'nav') return gotoChange(Number(d.step), false);
    if (act === 'whole' || act === 'layout' || act === 'revdiff') {
      // The line at the top of the screen stays there.
      const at = lineOnScreen();
      if (act === 'whole') state.whole.has(d.p) ? state.whole.delete(d.p) : state.whole.add(d.p);
      else if (act === 'revdiff') { state.showReviewedDiff = !state.showReviewedDiff; save(); }
      else { state.layout = state.layout === 'split' ? 'unified' : 'split'; save(); }
      render();
      backTo(at);
      return;
    }
    if (act === 'mark-file') { const bs = m.files[Number(d.file)].blocks.filter((b) => b.edits.length); toggleBlocks(bs); hint({ mark: bs.map((b) => b.id) }); return render(); }
    if (act === 'mark-blocks') { toggleBlocks(blocksOf(d.blocks.split(' '))); hint(markHint(d.blocks.split(' '), t)); return render(); }
    if (act === 'mark-chain') { toggleBlocks(blocksOf(m.chains[Number(d.chainId)].blocks)); hint({ mark: m.chains[Number(d.chainId)].blocks }); return render(); }
    if (act === 'mark-standalone') { toggleBlocks(m.standalone); hint({ mark: m.standalone.map((b) => b.id) }); return render(); }
    if (act === 'mark-edits') { const ids = d.edits.split(' ').map(Number); setEdits(ids, !ids.every((x) => rev().has(x))); hint({ mark: [] }); return render(); }
    if (act === 'toggle-member') { state.memberOpen.has(d.key) ? state.memberOpen.delete(d.key) : state.memberOpen.add(d.key); return render(); }
    if (act === 'ol-open') { hint({ ol: d.ol }); state.olOpen.has(d.ol) ? state.olOpen.delete(d.ol) : state.olOpen.add(d.ol); return render(); }
    if (act === 'ol-unfold') { hint({ ol: d.key, fold: true }); state.olUnfold.has(d.key) ? state.olUnfold.delete(d.key) : state.olUnfold.add(d.key); return render(); }
    if (act === 'ol-file') {
      if (t.getAttribute('aria-expanded') === 'true') { state.collapsed.add(d.key); state.expanded.delete(d.key); } else { state.collapsed.delete(d.key); state.expanded.add(d.key); }
      hint({ olf: t.closest('.ol-sec[data-olf]').dataset.olf });
      return render();
    }
    if (act === 'ol-chain') {
      // The chain that wrote a call, at its row.
      state.view = { kind: 'chain', id: Number(d.chainId) }; state.peek = null; state.focus = null; toChains();
      render({ top: true });
      const row = [...main.querySelectorAll('.ol-row[data-ol]')].find((x) => x.dataset.ol === d.ol);
      if (row) { placeRow(row, headH() + 60); flashRow(row); }
      return;
    }
    if (act === 'note-more') { const id = Number(d.family); state.noteOpen.has(id) ? state.noteOpen.delete(id) : state.noteOpen.add(id); return render(); }
    if (act === 'next-open') { const nx = nextUnreviewed(); if (nx) { state.view = nx; state.peek = null; state.focus = null; toChains(); return render({ top: true }); } return; }
    if (act === 'mark-group') { const g = m.groupById.get(Number(d.groupId)); setEdits(g.edits, !g.edits.every((x) => rev().has(x))); hint({ mark: [] }); return render(); }
    if (act === 'group-all') { state.groupAll.add(d.key); return render(); }
    if (act === 'mark-usages') {
      const list = REFS[state.compare][d.usage] || [];
      const hits = list.map(([up, ul]) => m.head.get(up + ':' + ul)).filter((hl) => hl && hl.r.block);
      const anyOpen = hits.some((hl) => !done(hl.r.block));
      hits.forEach((hl) => {
        const ranges = hl.f.hunks[hl.hi].rows[hl.ri][2] || [];
        const ids = ranges.length ? [...new Set(ranges.map((x) => x[2]))] : hl.r.block.edits;
        setEdits(ids, anyOpen);
      });
      return render();
    }
  });
  // The keys: Ctrl K, Ctrl B and Esc anywhere; the others outside text boxes. ? lists them.
  const typingIn = (t) => !!(t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]'));
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); return PAL.open ? palClose() : palOpen(); }
    if (mod && (e.key === 'b' || e.key === 'B') && !typingIn(e.target)) { e.preventDefault(); return toggleSide(); }
    if (e.altKey && e.key === 'ArrowLeft' && !NAV.hist && NAV.at > 0 && !typingIn(e.target)) { e.preventDefault(); return navBack(); }
    if (e.key === 'Escape') {
      if (SIDE.open) return sideDrawer(false);
      if (keysEl && !keysEl.hidden) return toggleKeys(false);
      if (PAL.open) return palClose();
      if (MENU.open) return closeMenu();
      if (state.gdrop) return gdClose();
      if (GH.reviewOpen) { GH.reviewOpen = false; return render(); }
      if (NT.agentOpen) { NT.agentOpen = null; return renderAgent(); }
      if (state.peek) { state.peek = null; return render(); }
      if (PICK.path) return pickClear();
      if (HX && HX.detail && state.view.kind === 'history') { HX.detail = null; return render(); }
      if (state.card && state.view.kind === 'chain' && main.querySelector('.hs-detail')) { state.card = null; return render(); }
      if (state.lens) return setLens(null);
      return;
    }
    // Up and down walk an open menu.
    if (MENU.open && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && MENU.el.contains(document.activeElement)) {
      const items = [...MENU.el.querySelectorAll('button:not(:disabled), a[href]')];
      const next = items[(items.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      if (next) { e.preventDefault(); next.focus(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || typingIn(e.target) || (e.target.matches && e.target.matches('.pk-code')) || PAL.open) return;
    // Space on a button presses it.
    if (e.key === ' ' && e.target.closest && e.target.closest('button, a, [role="button"], summary')) return;
    if (e.key === 'j' || e.key === 'k') gotoChange(e.key === 'j' ? 1 : -1, true);
    else if (e.key === ' ') { if (e.shiftKey) markScope(); else markAndNext(); }
    else if (e.key === 'n' || e.key === 'p') goChain(e.key === 'n' ? 1 : -1);
    else if (e.key === 'g' && gdHas()) { if (state.gdrop) gdClose(); else gdOpen(true); }
    else if (e.key === 'c') commentHere();
    else if (e.key === '?') toggleKeys();
    else if (e.key === '/') palOpen();
    else return;
    e.preventDefault();
  });
  // A click outside the open menu closes it.
  document.addEventListener('click', (e) => {
    if (MENU.open && !e.target.closest('.menu, [data-menu]')) closeMenu();
    if (state.gdrop && state.gdrop.kept && !gdSpot(e.target)) gdClose();
  }, true);
  // So does a click outside a peek, unless it was a drag (selecting text) or asks about another
  // name or a move's other copy (which open their own peek, or close this one). Whatever the click
  // does draws the page; when it does nothing, the page is drawn here.
  let downAt = null;
  document.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; }, { passive: true, capture: true });
  document.addEventListener('click', (e) => {
    if (!state.peek || !main.querySelector(PEEK) || !(e.target instanceof Element)) return;
    if (e.target.closest('.peek, .ref, [data-act="hd-open"], [data-act="move-peek"], .menu, .pal, .scrim, .keys, .mn-pop')) return;
    if (downAt && e.detail && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
    state.peek = null;
    setTimeout(() => { if (!state.peek && main.querySelector(PEEK)) render(); }, 0);
  }, true);
  window.addEventListener('resize', () => { if (MENU.open) renderMenu(); roomToFold(); });
  viewer.addEventListener('keydown', (e) => {
    if (mentionKey(e)) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.dataset && e.target.dataset.draft != null) {
      const btn = e.target.closest('.cmp') && e.target.closest('.cmp').querySelector('[data-primary]');
      if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.ol-row[data-act], .ol-fold[data-act], .ol-file[data-act]')) { e.preventDefault(); e.target.click(); return; }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('g[data-node],g[data-graph-open],g[data-chain],g[data-act="ext-box"]')) { e.preventDefault(); e.target.closest('g[data-node],g[data-graph-open],g[data-chain],g[data-act="ext-box"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  });
  viewer.addEventListener('change', (e) => {
    if (e.target.name === 'rv-event') GH.event = e.target.value;
    if (e.target.name === 'nt-scope') ntSettings({ scope: e.target.value });
    if (e.target.name === 'nt-live') ntSettings({ live: e.target.checked });
  });

  // ---------- panels: the sidebar's width (drag its edge, or use ← and → on it); a double-click
  // on the edge, or Ctrl B, hides the sidebar and brings it back. Kept in this browser.
  const split = $('#vw-split'), sideBtn = $('#vw-side-btn');
  const SIDE_MIN = 200;
  const sideMax = () => Math.max(SIDE_MIN, Math.min(640, Math.round(window.innerWidth * 0.5)));
  const clampSide = (w) => Math.min(sideMax(), Math.max(SIDE_MIN, Math.round(w)));
  function applySide() {
    const w = clampSide(UI.side);
    viewer.style.setProperty('--side-w', w + 'px');
    viewer.classList.toggle('side-off', !!UI.sideOff);
    if (sideBtn) sideBtn.hidden = !UI.sideOff;
    split.setAttribute('aria-valuemin', String(SIDE_MIN));
    split.setAttribute('aria-valuemax', String(sideMax()));
    split.setAttribute('aria-valuenow', String(UI.sideOff ? 0 : w));
    split.title = UI.sideOff ? 'Drag to show the sidebar' : 'Drag to resize the sidebar; double-click to hide it';
  }
  function toggleSide() {
    if (compact()) return sideDrawer(!SIDE.open);
    UI.sideOff = !UI.sideOff;
    saveUI();
    applySide();
    mini.update();
  }
  // Contents, over the view in a narrow window: out of reach while it's closed, and closed again
  // once the window is wide.
  function sideDrawer(open) {
    SIDE.open = open && compact();
    SIDE.at = viewKey();
    viewer.classList.toggle('side-on', SIDE.open);
    side.inert = compact() && !SIDE.open;
    const btn = $('#vw-contents');
    if (btn) btn.setAttribute('aria-expanded', String(SIDE.open));
    if (SIDE.open) {
      renderSide();
      const cur = side.querySelector('[aria-current="true"]');
      if (cur) cur.scrollIntoView({ block: 'center' });
      (cur || side.querySelector('[role="tab"][aria-selected="true"]') || side).focus({ preventScroll: true });
    } else if (side.contains(document.activeElement)) ($('#vw-contents') || main).focus({ preventScroll: true });
    layerSoon();
  }
  COMPACT.addEventListener('change', () => { sideDrawer(false); applyCode(); render(); });
  PHONE.addEventListener('change', () => { applyCode(); render(); });
  // Code's settings in a narrow window: wrapped or not, and its size (the rows follow it).
  function applyCode() {
    viewer.classList.toggle('wrap', wrapOn());
    viewer.classList.toggle('ol-all', testDetails());
    if (compact() && UI.codeSize) viewer.style.setProperty('--code-fs', UI.codeSize + 'px');
    else viewer.style.removeProperty('--code-fs');
  }
  let resizing = null;
  split.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    split.setPointerCapture(e.pointerId);
    resizing = { x: e.clientX, w: UI.sideOff ? 0 : side.getBoundingClientRect().width, raf: 0 };
    split.classList.add('dragging');
    document.body.classList.add('resizing');
  });
  split.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const w = resizing.w + e.clientX - resizing.x;
    // Dragged most of the way out, the sidebar hides.
    if (w < SIDE_MIN * 0.6) UI.sideOff = true;
    else { UI.sideOff = false; UI.side = clampSide(w); }
    if (!resizing.raf) resizing.raf = requestAnimationFrame(() => { if (resizing) resizing.raf = 0; applySide(); });
  });
  const endResize = () => {
    if (!resizing) return;
    resizing = null;
    split.classList.remove('dragging');
    document.body.classList.remove('resizing');
    applySide();
    saveUI();
    mini.update();
  };
  split.addEventListener('pointerup', endResize);
  split.addEventListener('pointercancel', endResize);
  split.addEventListener('dblclick', toggleSide);
  split.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      UI.sideOff = false;
      UI.side = clampSide(UI.side + (e.key === 'ArrowRight' ? 16 : -16));
      applySide();
      saveUI();
      mini.update();
    } else if (e.key === 'Enter') toggleSide();
  });
  window.addEventListener('resize', () => { applySide(); mini.update(); });
  applySide();
  sideDrawer(false);
  applyCode();

  // ---------- the minimap: the view's rows drawn small at the right of the code, with the diff's
  // colors, amber for what's left to review and blue for threads, and the part on screen. A click
  // or a drag moves there. Taller views scroll in it, as in VS Code.
  const mini = (() => {
    const cv = $('#vw-mini');
    const SCALE = 2 / 20.625;
    let rows = [], stale = true, raf = 0, drag = null, hover = false, settle = 0, measured = 0;
    // Not in the Tests view, nor for a test's code opened under its sentence in a chain: coming
    // and going with it, the minimap would narrow the page and move the sentences.
    const on = () => !!cv && UI.minimap && window.innerWidth > 960 && state.view.kind !== 'tests' && !!main.querySelector('.code:not(.ol-sec .code)');
    // Where each row is in the pane, and what it is.
    function build() {
      stale = false;
      measured = main.scrollHeight;
      rows = [];
      const top = main.getBoundingClientRect().top - main.scrollTop;
      main.querySelectorAll('.ln, .sl, .hh, .th, .peek, .sec-h, .sym-h, .sec-file, .inst-file, .strip, .graph-box, .focus-bar').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!r.height) return;
        const row = { y: r.top - top, h: r.height, k: 'head' };
        const c = el.classList;
        if (c.contains('ln') || c.contains('sl')) {
          row.k = c.contains('add') || el.querySelector(':scope > .half.add') ? 'add' : c.contains('del') ? 'del' : c.contains('mv') || c.contains('mv-head') ? 'mv' : 'ctx';
          row.rv = c.contains('rvd') || c.contains('rvd-quiet') || c.contains('gone') || c.contains('lens-out');
          row.todo = !row.rv && (row.k === 'add' || row.k === 'del' || !!el.querySelector(':scope > .half.del'));
          const tx = el.querySelector('.half.r .tx') || el.querySelector('.tx');
          const text = tx ? tx.textContent : '';
          const ind = text.length - text.trimStart().length;
          row.ind = Math.min(40, ind);
          row.len = Math.min(70, text.trim().length);
        } else if (c.contains('hh')) { row.k = 'div'; row.todo = el.hasAttribute('data-nav'); }
        else if (c.contains('th')) row.k = 'th';
        else if (c.contains('peek')) row.k = 'peek';
        rows.push(row);
      });
    }
    function geom() {
      const h = cv.clientHeight, S = main.scrollHeight, C = main.clientHeight;
      const full = S * SCALE, vh = Math.max(8, C * SCALE);
      const t = S > C ? main.scrollTop / (S - C) : 0;
      const track = Math.max(0, Math.min(h, full) - vh);
      return { h, S, C, vh, vy: t * track, off: full > h ? t * (full - h) : 0, track };
    }
    function draw() {
      raf = 0;
      const show = on();
      viewer.classList.toggle('mini-on', show);
      cv.hidden = !show;
      if (!show) return;
      const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      if (stale) build();
      const g = geom(), x = cv.getContext('2d');
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, w, h);
      for (const r of rows) {
        const y = r.y * SCALE - g.off, rh = Math.max(1, r.h * SCALE);
        if (y + rh < 0 || y > h) continue;
        if (r.k === 'add' || r.k === 'del' || r.k === 'mv') {
          x.fillStyle = r.rv ? 'rgba(255,255,255,.035)' : r.k === 'add' ? 'rgba(63,185,80,.32)' : r.k === 'del' ? 'rgba(248,81,73,.32)' : 'rgba(150,128,255,.22)';
          x.fillRect(4, y, w - 8, rh);
        }
        if (r.len) {
          x.fillStyle = r.rv ? 'rgba(232,232,236,.12)' : 'rgba(232,232,236,.26)';
          const left = 8 + r.ind * 0.8;
          x.fillRect(left, y + 0.3, Math.max(1, Math.min(r.len * 0.8, w - 6 - left)), Math.max(1, rh - 0.8));
        }
        if (r.k === 'th') { x.fillStyle = 'rgba(92,157,248,.14)'; x.fillRect(8, y, w - 14, rh); x.fillStyle = '#5C9DF8'; x.fillRect(w - 3, y, 3, rh); }
        else if (r.k === 'peek') { x.fillStyle = 'rgba(255,255,255,.06)'; x.fillRect(8, y, w - 14, rh); }
        else if (r.k === 'div') { x.fillStyle = 'rgba(255,255,255,.08)'; x.fillRect(4, y + rh / 2, w - 8, 1); }
        else if (r.k === 'head') { x.fillStyle = 'rgba(232,232,236,.2)'; x.fillRect(8, y + 0.5, Math.min(w - 20, 28), Math.max(1, Math.min(2, rh - 1))); }
        if (r.todo) { x.fillStyle = '#E9B44C'; x.fillRect(0, y, 3, Math.max(rh, 1.5)); }
      }
      x.fillStyle = drag || hover ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.055)';
      x.fillRect(0, g.vy, w, g.vh);
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };
    if (cv) {
      cv.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        cv.setPointerCapture(e.pointerId);
        let g = geom();
        const y = e.offsetY;
        if (y < g.vy || y > g.vy + g.vh) {
          // Elsewhere: that point comes to the middle of the screen.
          main.scrollTop = (y + g.off) / SCALE - g.C / 2;
          g = geom();
        }
        drag = { grab: Math.max(0, Math.min(g.vh, y - g.vy)) };
        schedule();
      });
      cv.addEventListener('pointermove', (e) => {
        const g = geom();
        if (!drag) { const over = e.offsetY >= g.vy && e.offsetY <= g.vy + g.vh; if (over !== hover) { hover = over; schedule(); } return; }
        const t = g.track > 0 ? (e.offsetY - drag.grab) / g.track : 0;
        main.scrollTop = Math.max(0, Math.min(1, t)) * (g.S - g.C);
      });
      const stop = () => { if (drag) { drag = null; schedule(); } };
      cv.addEventListener('pointerup', stop);
      cv.addEventListener('pointercancel', stop);
      // A wheel over the minimap scrolls the code. It's listened to only while the pointer is over
      // it, for the reason a glide listens only while it runs (see stopGlide).
      const wheel = (e) => { main.scrollTop += e.deltaY; };
      cv.addEventListener('pointerenter', () => cv.addEventListener('wheel', wheel, { passive: true }));
      cv.addEventListener('pointerleave', () => { cv.removeEventListener('wheel', wheel); if (hover) { hover = false; schedule(); } });
    }
    return {
      // The view changed: its rows are measured again.
      update() { stale = true; schedule(); },
      // Scrolled: drawn again at once, and measured again once rows drawn on the way have settled,
      // when they changed the pane's height (measuring a long chain takes a while).
      scrolled() { schedule(); clearTimeout(settle); settle = setTimeout(() => { if (main.scrollHeight !== measured) { stale = true; schedule(); } }, 250); },
    };
  })();

  // ---------- the language server and untangle's metrics: a dot in the top bar with the memory and
  // CPU that untangle and its language server use together, each one's numbers under it on hover
  // (like px0's). Values change in place, so the popover stays open under the pointer.
  const lspEl = $('#vw-lsp');
  const bytes = (n) => (n == null ? '—' : n < 1048576 ? Math.round(n / 1024) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB');
  const percent = (x) => (x == null ? '—' : x.toFixed(1) + '%');
  // The two together, short enough to read at a glance: "1.4 GB · 3.2%".
  const usage = (m) => {
    const mem = (m.rss || 0) + (m.lsp.rss || 0), cpu = (m.cpu || 0) + (m.lsp.cpu || 0);
    return `${mem < 1073741824 ? Math.round(mem / 1048576) + ' MB' : (mem / 1073741824).toFixed(1) + ' GB'} · ${cpu < 10 ? cpu.toFixed(1) : Math.round(cpu)}%`;
  };
  let metricsMisses = 0, metricsTimer = null, lspState = 'off';
  function showMetrics(m) {
    const set = (k, v) => { const el = lspEl.querySelector(`[data-m="${k}"]`); if (el) el.textContent = v; };
    const dot = $('#lsp-dot'), head = $('#lsp-state'), pid = $('#lsp-pid'), use = $('#lsp-use');
    if (!m) {
      dot.className = 'dot failed';
      use.textContent = '';
      head.textContent = 'untangle isn’t answering: run it again to keep reviewing';
      pid.hidden = true;
      lspEl.setAttribute('aria-label', head.textContent);
      return;
    }
    const lsp = m.lsp;
    lspState = lsp.state;
    dot.className = 'dot ' + lsp.state;
    head.textContent = { ready: 'Dart analysis server, running', starting: 'Dart analysis server, starting', off: 'Dart analysis server, not running yet', failed: `Dart analysis server, failed: ${lsp.error || ''}` }[lsp.state] || '';
    // Its process on a line of its own.
    pid.textContent = lsp.state === 'ready' && lsp.pid ? `pid ${lsp.pid}` : '';
    pid.hidden = !pid.textContent;
    use.textContent = usage(m);
    lspEl.setAttribute('aria-label', `${head.textContent}${pid.textContent ? `, ${pid.textContent}` : ''}. Memory and CPU: ${use.textContent}`);
    set('rss', bytes(m.rss));
    set('cpu', percent(m.cpu));
    set('resources', String(m.resources));
    set('lspRss', lsp.state === 'ready' ? bytes(lsp.rss) : lsp.state);
    set('lspCpu', lsp.state === 'ready' ? percent(lsp.cpu) : '—');
    // Its memory freed by starting it over, once it runs.
    const free = $('#lsp-free');
    free.hidden = lsp.state !== 'ready';
    free.disabled = false;
  }
  function pollMetrics() {
    clearTimeout(metricsTimer);
    if (document.visibilityState === 'hidden') return;
    fetch('api/metrics', { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((m) => { metricsMisses = 0; showMetrics(m); metricsTimer = setTimeout(pollMetrics, 2000); })
      .catch(() => { if (++metricsMisses >= 3) return showMetrics(null); metricsTimer = setTimeout(pollMetrics, 2000); });
  }
  if (CONFIG.served && revsEl) {
    revsEl.hidden = false;
    rvLoad();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') rvLoad(); });
  }
  if (CONFIG.served && lspEl) {
    lspEl.hidden = false;
    pollMetrics();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pollMetrics(); });
  }

  let glowFrom = null, resumeSince = null;
  try {
    const r = JSON.parse(sessionStorage.getItem(RESUME) || 'null');
    sessionStorage.removeItem(RESUME);
    if (r) {
      if (r.tab) state.tab = r.tab;
      const c = r.chain && M().chains.find((x) => x.name === r.chain);
      if (r.kind === 'file' && r.path && (M().files.some((f) => f.p === r.path) || M().generated.some((f) => f.p === r.path))) state.view = { kind: 'file', path: r.path };
      else if (c) state.view = { kind: 'chain', id: c.id };
      else if (r.kind === 'conversation' && GH.on) state.view = { kind: 'conversation' };
      else if (r.kind === 'standalone') state.view = { kind: 'standalone' };
      else if (r.kind === 'history' && HX) state.view = { kind: 'history' };
      else if (r.kind === 'tests') state.view = { kind: 'tests' };
      if (r.from && CONFIG.head && r.from !== CONFIG.head) glowFrom = r.from;
      if (r.lens && HX && r.lens.kind === 'commits') { const shas = (r.lens.shas || []).filter((x) => HX.index.has(x)); if (shas.length) state.lens = { kind: 'commits', shas }; }
      else if (r.lens && HX && r.lens.kind === 'since' && r.lens.from) resumeSince = r.lens;
    }
  } catch (e) { /* storage unavailable */ }
  if (CONFIG.served) {
    setInterval(() => { if (document.visibilityState === 'visible') freshCheck(); }, 120000);
    setTimeout(freshCheck, 5000);
  }
  if (NT.on) {
    // The page comes with the notes; untangle says when they change (an agent answered).
    if (CONFIG.notes) ntSet(CONFIG.notes); else ntLoad();
    addEventListener('untangle:push', (e) => { const p = e.detail || {}; if ('notes' in p && (p.notes == null || !NT.data || p.notes !== NT.data.rev)) ntLoad(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') ntLoad(); });
    // While an agent holds the review, its commits show within seconds.
    setInterval(() => { if (document.visibilityState === 'visible' && agentsNow().length) { freshCheck(); renderAgent(); } }, 5000);
  }
  if (GH.on) {
    ghLoad(true);
    // New comments from others show up while the page is on screen.
    setInterval(() => { if (document.visibilityState === 'visible' && !GH.busy && Date.now() - GH.at > 60000) ghLoad(true); }, 15000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !GH.busy && Date.now() - GH.at > 20000) ghLoad(true); });
  }
  render({ top: true });
  // The commits' live part (your last review, GitHub's checks and force pushes), and a lens kept
  // through a reload.
  loadCommits();
  if (resumeSince) lensSince(resumeSince.from, resumeSince.why);
  // Reloaded on newer commits: the lines they changed glow once.
  if (glowFrom && CONFIG.served) {
    api('changed?from=' + encodeURIComponent(glowFrom)).then((r) => r.json()).then((j) => {
      if (!j.files || !moving()) return;
      glow = { files: j.files, at: Date.now() };
      glowRows();
    }).catch(() => {});
  }
  if (SHIKI) SHIKI.load().then(() => { if (typeof SHIKI.fg === 'function') shikiFg = SHIKI.fg(); shikiOn = true; render(); }).catch(() => {});
})();
