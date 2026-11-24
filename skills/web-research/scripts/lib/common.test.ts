import assert from "node:assert/strict";
import test from "node:test";
import { socialBlocked } from "./common.ts";

const BLOCKED: string[] = [
  "https://x.com/elonmusk/status/123",
  "https://x.com",
  "http://instagram.com/p/xyz/",
  "https://www.instagram.com/reel/abc",
  "https://m.facebook.com/story.php?id=1",
  "https://facebook.com/",
  "https://tiktok.com/@user/video/123",
  "https://www.tiktok.com/discover?q=1",
  "https://linkedin.com/in/someone",
  "https://www.linkedin.com/pulse/article",
  "https://twitter.com/elonmusk",
  "https://mobile.twitter.com/user",
  "https://sub.twitter.com/x",
  "https://deep.sub.instagram.com/p/1",
  "https://x.com?ref=feed",
  "https://x.com#comments",
  "https://instagram.com/",
  "HTTPS://X.COM/STATUS/1",
  "https://InstaGram.COM/p/xyz",
  "https://x.com:443/elonmusk",
  "http://instagram.com:8080/p/xyz",
  "https://user@x.com/",
  "https://evil.com@x.com/status/1",
  "https://x.com./status/1",
  "https://twitter.com./elonmusk",
];

const ALLOWED: string[] = [
  "https://netflix.com/title/1",
  "https://dropbox.com/s/abc",
  "https://notx.com/",
  "https://xx.com/",
  "https://example.com/x.com",
  "https://example.com/?ref=https://x.com/",
  "https://medium.com/@user/post",
  "https://evil.com/@x.com/",
  "https://x.company.com/",
  "https://facebook.com.evil.com/",
  "https://twitter.dev/user",
  "https://instagram.io/p/1",
  "x.com/status/1",
  "instagram.com/p/xyz",
  "//x.com/elonmusk",
  "",
];

test("socialBlocked blocks social hosts", () => {
  for (const u of BLOCKED) {
    assert.ok(socialBlocked(u), `expected blocked: ${u}`);
  }
});

test("socialBlocked allows non-social and unparseable", () => {
  for (const u of ALLOWED) {
    assert.ok(!socialBlocked(u), `expected allowed: ${u}`);
  }
});
