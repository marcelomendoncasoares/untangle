/** What each line of a Markdown file starts inside (a fenced code block, the front matter, a comment over lines), as the line that opens it; '' is a line outside them. Line n is at [n - 1]. */
export declare function markdownOpenings(text: string): string[];
