import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const source=await readFile(new URL('../src/pages/MobileAssignmentDetailPage.tsx',import.meta.url),'utf8');
const styles=await readFile(new URL('../src/pages/MobileMeasurementList.css',import.meta.url),'utf8');
const component=source.match(/^function MobileCustomerEmailStatus\([^]*?^}\n/m)[0];
const compiled=await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {MailCheck,MailX} from 'lucide-react';
  ${component}
  export const render=item=>renderToStaticMarkup(React.createElement(MobileCustomerEmailStatus,{item}));`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'tsx'},bundle:true,write:false,format:'cjs',platform:'node',packages:'external',jsx:'automatic'});
const module={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);

test('unsent cards show a red envelope with accessible status but no visible text',()=>{
  for(const item of [{},{customer_email_sent_at:null},{customer_email_sent_at:null,customer_signed_at:'2026-09-21'}]){
    const html=module.exports.render(item);
    assert.match(html,/mobile-document-email-indicator is-not-sent/);
    assert.match(html,/lucide-mail-x/);
    assert.match(html,/role="img" aria-label="Mail nicht an Kunden gesendet"/);
    assert.match(html,/title="Mail nicht an Kunden gesendet"/);
    assert.equal(html.replace(/<[^>]*>/g,''),'');
  }
  assert.match(styles,/mobile-document-email-indicator.is-not-sent svg \{\s*color: #c53045;/);
});

test('sent cards show green envelopes regardless of signature status',()=>{
  for(const signed of [null,'2026-09-21']){
    const html=module.exports.render({customer_email_sent_at:'2026-09-21',customer_signed_at:signed,customer_email_signature_present:Boolean(signed)});
    assert.match(html,/mobile-document-email-indicator is-sent/);
    assert.match(html,/lucide-mail-check/);
    assert.match(html,/aria-label="Mail an Kunden gesendet"/);
    assert.doesNotMatch(html,/is-signature-open/);
    assert.equal(html.replace(/<[^>]*>/g,''),'');
  }
  assert.match(styles,/mobile-document-email-indicator.is-sent svg \{\s*color: #2f8050;/);
});

test('both card lists place the indicator between header date and footer hours',()=>{
  for(const item of ['order','batch']){
    assert.match(source,new RegExp(`className="mobile-measurement-card-head"[^]*?<MobileCustomerEmailStatus item=\\{${item}\\} \\/>\\s*<span className="mobile-measurement-card-footer">`));
  }
  assert.equal((source.match(/<MobileCustomerEmailStatus item=/g)||[]).length,2);
  assert.match(styles,/mobile-measurement-card.is-document-card \{[^}]*grid-template-rows: auto minmax\(24px, 1fr\) auto;/s);
  assert.match(styles,/mobile-measurement-card.is-document-card \.mobile-document-email-indicator \{[^}]*align-self: center;[^}]*justify-self: end;/s);
});
