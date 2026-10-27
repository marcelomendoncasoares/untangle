// What each line of a Markdown file starts inside, as the line that opens it: a fenced code block
// (``` or ~~~, with its language), the front matter on the first line (---), a comment over
// several lines (<!--). Each ends as VS Code's Markdown grammar ends it: a fence at the same or a
// shallower indent, the front matter's dashes again, -->. A highlighter given that line first
// starts the line as the file does. Line n is at [n - 1]. '' is the first line; any other outside
// them starts after ' ', which opens nothing: the grammar looks for front matter on the first line
// it's given that isn't empty, so dashes there would read as front matter.
export function markdownOpenings(text) {
  let open = '', ends = null;
  return text.split('\n').map((raw, i) => {
    const line = raw.replace(/\r$/, ''), at = open || (i ? ' ' : '');
    if (ends) {
      if (ends(line)) { open = ''; ends = null; }
      return at;
    }
    const front = i === 0 && /^-{3,}/.exec(line);
    const fence = /^(\s*)(`{3,}|~{3,})[^`]*$/.exec(line);
    if (front) {
      ends = (l) => { const m = /^ {0,3}(-+)[\t ]*$/.exec(l); return (!!m && m[1].length >= front[0].length) || /^[\t ]*\.{3}$/.test(l); };
    } else if (fence) {
      ends = (l) => { const m = /^(\s*)(`{3,}|~{3,})\s*$/.exec(l); return !!m && m[2] === fence[2] && (m[1] === fence[1] || /^\s{0,3}$/.test(m[1])); };
    } else if (/^\s*<!--/.test(line) && !line.includes('-->', line.indexOf('<!--') + 4)) {
      ends = (l) => l.includes('-->');
    }
    if (ends) open = line;
    return at;
  });
}
