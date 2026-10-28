"use strict";

/** Sender must be the trusted window's main frame at its exact app origin. */
function trustedSender(event, origin, BrowserWindow) {
	const win = BrowserWindow.fromWebContents(event.sender);
	try {
		return !!win && event.senderFrame === event.sender.mainFrame && new URL(event.senderFrame.url).origin === origin;
	} catch { return false; }
}
module.exports = { trustedSender };
