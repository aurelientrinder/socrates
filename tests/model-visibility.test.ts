import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleModels } from "../components/settings/model-menu";
import { toggleShown } from "../components/settings/model-visibility";
import { parseModelListSettingsBody } from "../src/server/settings-body";
import { sanitizeUserSettings } from "../src/core";

const m = (provider: string, id: string) => ({ provider, id, name: id }) as never;
const models = [m("a", "x"), m("a", "y"), m("a", "z"), m("b", "q")];

test("visibleModels narrows only listed providers and keeps the chosen model", () => {
	assert.equal(visibleModels(models, undefined).length, 4);
	assert.deepEqual(visibleModels(models, { a: ["x"] }).map((e) => e.id), ["x", "q"]);
	assert.deepEqual(visibleModels(models, { a: ["x"] }, { provider: "a", id: "z" }).map((e) => e.id), ["x", "z", "q"]);
});

test("toggleShown drops the key at all-shown and refuses the last one", () => {
	const ids = ["x", "y", "z"];
	assert.deepEqual(toggleShown(ids, undefined, "y"), ["x", "z"]);
	assert.equal(toggleShown(ids, ["x", "z"], "y"), null);
	assert.equal(toggleShown(ids, ["x"], "x"), undefined);
});

test("modelList parser is strict, sanitizer is lenient", () => {
	assert.equal(parseModelListSettingsBody({ shown: { a: [] } }).ok, false);
	assert.equal(parseModelListSettingsBody({ shown: { a: [1] } }).ok, false);
	assert.deepEqual(parseModelListSettingsBody({ shown: { a: ["x", "x"] } }), { ok: true, settings: { shown: { a: ["x"] } } });
	assert.deepEqual(sanitizeUserSettings({ version: 1, modelList: { shown: { a: ["x", 3], b: "no" } } })?.modelList, { shown: { a: ["x"] } });
});
