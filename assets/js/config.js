// Site configuration.
export const CONFIG = {
  // Optional Cloudflare Worker that relays Sina real-time futures quotes (see /worker).
  // When empty, futures quotes come from Eastmoney's public JSONP feed, then fall back to the last close.
  quoteProxy: "",
  // How often futures quotes are polled during trading hours (ms).
  futuresPollMs: 15000,
};
