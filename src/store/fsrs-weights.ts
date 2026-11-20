/**
 * Personal FSRS-6 weights store (data/fsrs-weights.json): persists the
 * learner's fitted 21-parameter FSRS-6 weight vector and its evaluation
 * metrics. Absent or invalid file cleanly falls back to FSRS-6 defaults.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { FSRS_WEIGHTS, type FsrsWeights } from "../core/retention.ts";
import { isValidFsrsWeights, type FsrsFitResult } from "../core/fsrs-fit.ts";
import { writeFileAtomic } from "./fs-atomic.ts";

export interface StoredFsrsWeights {
	version: 1;
	weights: number[];
	reviews: number;
	baselineLogLoss: number;
	fittedLogLoss: number;
	baselineBrier: number;
	fittedBrier: number;
	fittedAt: number;
}

function weightsFile(): string {
	return path.join(PATHS.data, "fsrs-weights.json");
}

export function readStoredFsrsWeights(): StoredFsrsWeights | null {
	try {
		const raw = JSON.parse(fs.readFileSync(weightsFile(), "utf-8")) as Partial<StoredFsrsWeights>;
		if (raw.version !== 1 || !isValidFsrsWeights(raw.weights)) return null;
		if (typeof raw.reviews !== "number" || typeof raw.fittedAt !== "number") return null;
		return raw as StoredFsrsWeights;
	} catch {
		return null;
	}
}

/** Active FSRS-6 weights: personal weights when fitted, else published defaults. */
export function activeFsrsWeights(): FsrsWeights {
	return readStoredFsrsWeights()?.weights ?? FSRS_WEIGHTS;
}

export function saveFsrsWeights(fit: FsrsFitResult): StoredFsrsWeights {
	const record: StoredFsrsWeights = {
		version: 1,
		weights: [...fit.weights],
		reviews: fit.reviews,
		baselineLogLoss: fit.baselineLogLoss,
		fittedLogLoss: fit.fittedLogLoss,
		baselineBrier: fit.baselineBrier,
		fittedBrier: fit.fittedBrier,
		fittedAt: fit.fittedAt,
	};
	fs.mkdirSync(PATHS.data, { recursive: true });
	writeFileAtomic(weightsFile(), JSON.stringify(record, null, 2));
	return record;
}

export function clearFsrsWeights(): void {
	try {
		fs.unlinkSync(weightsFile());
	} catch {
		// already absent
	}
}
