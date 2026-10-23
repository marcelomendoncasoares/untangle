import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { progressPage, reviewPage, type PageConfig } from '../../dist/page.js';
import type { ReviewData } from '../../dist/build.js';

const placeholders = ['/*TITLE*/', '<!--FONTS-->', '<!--HIGHLIGHT-->', '/*CORE*/', '/*CONFIG*/', '/*MODEL*/', '/*DEFS*/', '/*REFS*/', '/*DEFSOLD*/', '/*HISTORY*/', '/*VIEWER*/'];

function review(note: string): ReviewData {
  return {
    model: { compares: { base: { label: 'main', files: [], generated: [], edits: [], groups: [], chains: [], note } } },
    defs: { targets: [], defs: {} },
    refs: {},
    defsOld: { base: { targets: [], defs: {} } },
    history: null,
  };
}

const config: PageConfig = { served: true, key: 'local/sample', state: null, url: null, where: 'sample · main → abcdef0' };

function modelScript(html: string): string {
  const marker = 'id="d-model">';
  const start = html.indexOf(marker) + marker.length;
  return html.slice(start, html.indexOf('</script>', start));
}

describe('Given a review whose data contains "</script>", ', () => {
  const data = review('</script><script>alert(1)</script>');

  describe('when the page is rendered, ', () => {
    let html: string;

    before(() => {
      html = reviewPage(data, 'A <review>', 'served')(config);
    });

    it('then that text cannot close the script it is in.', () => {
      assert.equal(modelScript(html).includes('<'), false);
    });

    it('then the text reads back as it was.', () => {
      const model = JSON.parse(modelScript(html)) as { compares: { base: { note: string } } };
      assert.equal(model.compares.base.note, '</script><script>alert(1)</script>');
    });

    it('then every data script is still in the one document, in order.', () => {
      assert.equal([...html.matchAll(/<script[^>]*id="([^"]+)"/g)].map((match) => match[1]).join(' '), 'd-config d-model d-defs d-refs d-defs-old d-history');
    });

    it('then every placeholder is replaced.', () => {
      assert.equal(placeholders.filter((token) => html.includes(token)).join('\n'), '');
    });

    it('then the title is in the document.', () => {
      assert.equal(/<title>([^<]*)<\/title>/.exec(html)?.[1], 'A &lt;review&gt; · untangle');
    });
  });
});

describe('Given the page a review shows while it is built, ', () => {
  describe('when it is rendered, ', () => {
    it('then it has the review page’s icon, so the tab shows it from the start.', () => {
      const icon = (html: string) => /<link rel="icon" href="[^"]+">/.exec(html)?.[0];
      assert.ok(icon(progressPage()));
      assert.equal(icon(progressPage()), icon(reviewPage(review(''), 'A review', 'served')(config)));
    });
  });
});
