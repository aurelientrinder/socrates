/**
 * Allow-list SVG sanitizer for model-written figures.
 *
 * The figure comes from a model that has read web pages and PDFs, so it is
 * untrusted markup landing in the app's own DOM (where script could call
 * the local API). Instead of stripping known-bad patterns, this rebuilds
 * the markup from the tags and attributes that drawing needs and nothing
 * else: no script, foreignObject, iframe, animation (SMIL can set an href
 * to javascript:), no event handlers, links only to ids in the figure, and
 * images only as inline raster data. Pure and browser-safe.
 */

const ALLOWED_ELEMENTS = new Set([
	"svg", "g", "defs", "symbol", "use", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
	"text", "tspan", "textpath", "title", "desc", "marker", "pattern", "clippath", "mask", "lineargradient",
	"radialgradient", "stop", "filter", "fegaussianblur", "feoffset", "feblend", "fecolormatrix", "feflood",
	"fecomposite", "femerge", "femergenode", "fedropshadow", "style", "a", "image",
]);

/** Tags whose whole contents go with them. */
const DROP_WITH_CONTENT = new Set([
	"script", "foreignobject", "iframe", "object", "embed", "animate", "animatetransform", "animatemotion", "set",
	"audio", "video", "canvas", "link", "meta", "base", "form", "input", "button", "textarea", "select", "noscript", "template",
]);

const TAG = /<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const RASTER_DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]*$/i;

function plain(value: string): string {
	// Entities and control characters are how "java&#x73;cript:" slips past
	// string checks; look at the value the browser would see.
	return value
		.replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16) || 0))
		.replace(/&#(\d+);?/g, (_, d: string) => String.fromCodePoint(Number(d) || 0))
		.replace(/&(?:tab|newline|colon);?/gi, (m) => (/colon/i.test(m) ? ":" : ""))
		.replace(/[\u0000- \u007f-\u009f]+/g, "")
		.toLowerCase();
}

function safeCss(css: string): string {
	return css
		.replace(/@import[^;]*;?/gi, "")
		.replace(/url\(\s*(?!["']?\s*#)[^)]*\)/gi, "none")
		.replace(/expression\s*\(|javascript:|-moz-binding|behavior\s*:/gi, "");
}

function escapeAttr(value: string): string {
	return value.replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cleanAttributes(element: string, raw: string): string {
	let out = "";
	for (const m of raw.matchAll(ATTR)) {
		const name = m[1]!;
		const lower = name.toLowerCase();
		const value = m[2] ?? m[3] ?? m[4] ?? "";
		if (lower.startsWith("on") || lower === "srcdoc" || lower === "formaction") continue;
		if (!/^[a-z_][\w:.-]*$/i.test(name)) continue;
		const seen = plain(value);
		if (lower === "href" || lower === "xlink:href") {
			const target = value.trim();
			const ok = target.startsWith("#") || (element === "image" && RASTER_DATA_URL.test(target));
			if (!ok) continue;
		} else if (lower === "style") {
			out += ` style="${escapeAttr(safeCss(value))}"`;
			continue;
		} else if (/javascript:|vbscript:|data:text|data:application|data:image\/svg/.test(seen)) {
			continue;
		} else if (/url\(\s*(?!["']?\s*#)/i.test(value)) {
			continue; // paint servers and clips may point at ids in the figure only
		}
		out += value === "" && m[2] === undefined && m[3] === undefined && m[4] === undefined ? ` ${name}` : ` ${name}="${escapeAttr(value)}"`;
	}
	return out;
}

export function sanitizeSvg(svg: string): string {
	const input = svg
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner: string) => inner.replace(/</g, "&lt;"))
		.replace(/<[!?][^>]*>/g, "");
	let out = "";
	let last = 0;
	let skip: { name: string; depth: number } | null = null;
	let inStyle = false;
	const text = (chunk: string) => {
		if (skip) return;
		out += inStyle ? safeCss(chunk) : chunk.replace(/</g, "&lt;");
	};
	for (const m of input.matchAll(TAG)) {
		text(input.slice(last, m.index));
		last = m.index + m[0].length;
		const closing = m[1] === "/";
		const selfClosing = m[4] === "/";
		const name = m[2]!.toLowerCase();
		if (skip) {
			if (name === skip.name && !selfClosing) skip.depth += closing ? -1 : 1;
			if (skip.depth === 0) skip = null;
			continue;
		}
		if (DROP_WITH_CONTENT.has(name)) {
			if (!closing && !selfClosing) skip = { name, depth: 1 };
			continue;
		}
		if (!ALLOWED_ELEMENTS.has(name)) continue;
		if (closing) {
			out += `</${m[2]}>`;
			if (name === "style") inStyle = false;
			continue;
		}
		out += `<${m[2]}${cleanAttributes(name, m[3] ?? "")}${selfClosing ? "/" : ""}>`;
		if (name === "style" && !selfClosing) inStyle = true;
	}
	text(input.slice(last));
	return out;
}
