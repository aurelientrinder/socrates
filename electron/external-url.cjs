"use strict";

/** Links the app hands to the OS: web pages and mail. Anything else
 *  (file:, smb:, ms-*:, custom protocol handlers) can launch programs, so a
 *  poisoned link or figure must not reach shell.openExternal with them. */
const ALLOWED_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

function isSafeExternalUrl(target) {
	try {
		return ALLOWED_PROTOCOLS.has(new URL(String(target)).protocol);
	} catch {
		return false;
	}
}

module.exports = { isSafeExternalUrl };
