/**
 * The figure sanitizer (components/artifacts/sanitize-svg.ts): an
 * allow-list, so the bypasses a pattern-stripper misses stay out.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeSvg } from "../components/artifacts/sanitize-svg.ts";

const GOOD =
	'<svg viewBox="0 0 10 10" width="10"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
	'<rect x="1" y="1" width="8" height="8" fill="url(#g)" style="stroke:#000"/><text x="1" y="5">a &lt; b</text><use href="#g"/></svg>';

describe("sanitizeSvg", () => {
	it("keeps ordinary figures byte for byte in meaning", () => {
		const out = sanitizeSvg(GOOD);
		for (const piece of ['viewBox="0 0 10 10"', 'fill="url(#g)"', "<linearGradient", 'href="#g"', "a &lt; b", "<rect", "<text"]) {
			assert.ok(out.includes(piece), piece);
		}
	});

	it("drops script, foreignObject, iframes and animation, contents included", () => {
		const out = sanitizeSvg(
			'<svg><script>alert(1)</script><foreignObject><img src=x onerror=alert(2)></foreignObject><iframe srcdoc="&lt;script&gt;"></iframe>' +
				'<a><animate attributeName="href" values="javascript:alert(3)"/></a><set attributeName="onmouseover" to="alert(4)"/><circle r="1"/></svg>',
		);
		assert.ok(!/script|foreignobject|iframe|animate|<set|alert|onerror/i.test(out), out);
		assert.ok(out.includes("<circle"));
	});

	it("drops handlers however they are spelled", () => {
		const out = sanitizeSvg('<svg onload="x()"><rect/onclick="x()" width="1"/><circle ONMOUSEOVER=x() r="1"/><path d="M0 0" onfocus=\'x()\'/></svg>');
		assert.ok(!/<[a-z][^>]*on[a-z]+\s*=/i.test(out), out); // a mangled tag may survive only as escaped text
		assert.ok(out.includes("<circle") && out.includes('d="M0 0"'));
	});

	it("only lets links point inside the figure", () => {
		const out = sanitizeSvg(
			'<svg><a href="javascript:alert(1)"><rect/></a><a xlink:href="java&#x73;cript:alert(2)"><rect/></a><a href="https://evil.example/"><rect/></a>' +
				'<image href="data:image/svg+xml;base64,PHN2Zz4="/><image href="data:image/png;base64,iVBORw0KGgo="/><use href="#ok"/></svg>',
		);
		assert.ok(!/javascript|evil|svg\+xml|&#x73/i.test(out), out);
		assert.ok(out.includes('href="data:image/png;base64,iVBORw0KGgo="'));
		assert.ok(out.includes('href="#ok"'));
	});

	it("neutralizes external css and escapes stray markup", () => {
		const out = sanitizeSvg(
			'<svg><style>@import url(https://evil.example/x.css); .a{fill:url(https://evil.example/p)} .b{fill:url(#g)}</style><rect style="fill:url(//evil.example/p)" fill="url(http://evil.example/p)"/>1 < 2 <b onclick=x()>bold</b></svg>',
		);
		assert.ok(!/evil\.example|@import|onclick/i.test(out), out);
		assert.ok(out.includes("url(#g)"));
		assert.ok(!out.includes("<b"), "unknown tags are dropped");
	});

	it("does not let a comment or CDATA hide a tag", () => {
		const out = sanitizeSvg('<svg><!-- --><![CDATA[<script>alert(1)</script>]]><circle r="1"/></svg>');
		assert.ok(!/<script/i.test(out), out);
	});
});
