/**
 * Regression tests for the pure decision logic that drives tracking accuracy.
 *
 * Every case here corresponds to a bug that actually reached production once:
 * a healthy page marked degraded, a broken page marked degraded instead of down,
 * an exam keyed by a long slug, a channel key that wouldn't resolve, a QR file
 * named from the wrong field. They run with no database and no network:
 *   npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkContentVerdict, checkContent } from "../src/monitor/check";
import { effectiveName } from "../src/lib/examName";
import { effectiveLanding, effectivePractice, effectiveEntryLinks, hasUrlOverride } from "../src/lib/examUrls";
import { parseChannelKey, qrFilenameBase } from "../src/config/channels";
import { enumerateLinks, type PracticeBase } from "../src/collector/enumerate";

const body = (inner: string) => `<html><body>${inner}${"<p>" + "x".repeat(400) + "</p>"}</body></html>`;

// ── content verdicts: up vs degraded vs down ───────────────────────────────
test("a 200 page that is an error stub counts as broken (=> down)", () => {
  // The real C273 case: HTTP 200, 76-byte body, useless to a visitor.
  assert.equal(
    checkContentVerdict("PRACTICE", "<html><body>Could not load this exam. Check the exam code or database connection.</body></html>", null),
    "broken",
  );
});

test("PHP/DB error text is broken, not degraded", () => {
  assert.equal(checkContentVerdict("PRACTICE", "<b>Fatal error</b>: Uncaught Error: mysqli_connect()", null), "broken");
});

test("an empty question set with nothing rendered is broken", () => {
  assert.equal(checkContentVerdict("PRACTICE", body("<h1>Set 5</h1><div>No questions available</div>"), null), "broken");
});

test("a near-empty body is broken even without error text", () => {
  assert.equal(checkContentVerdict("PRACTICE", "<html><body></body></html>", null), "broken");
});

test("real questions render => ok", () => {
  assert.equal(checkContentVerdict("PRACTICE", body("<h2>Question 1: A nurse…</h2><button>Show Answer</button>"), null), "ok");
});

test("the word 'uncaught' inside an answer explanation stays ok", () => {
  // Regression: a nursing explanation ("errors that go uncaught") once tripped
  // the generic JS-error marker and flagged a healthy page.
  assert.equal(
    checkContentVerdict("PRACTICE", body("<h2>Question 3:</h2><p>errors that go uncaught without confirmation</p><button>Show Answer</button>"), null),
    "ok",
  );
});

test("'Warning:' in medical content stays ok", () => {
  assert.equal(checkContentVerdict("PRACTICE", body("<h2>Question 2:</h2><p>Warning: signs of sepsis</p><button>Show Answer</button>"), null), "ok");
});

test("a hidden empty-state template does not override rendered questions", () => {
  assert.equal(
    checkContentVerdict("PRACTICE", body("<h2>Question 1:</h2><button>Show Answer</button><div style='display:none'>No questions found</div>"), null),
    "ok",
  );
});

test("'Uncaught TypeError' inside a <script> bundle is ignored", () => {
  assert.equal(
    checkContentVerdict("PRACTICE", body("<h2>Question 1:</h2><button>Show Answer</button><script>if(e==='Uncaught TypeError'){}</script>"), null),
    "ok",
  );
});

test("a security exam explaining DoS ('service unavailable') stays ok", () => {
  // Regression: D488 Set 2/3 — 20 rendered questions, but an answer explaining
  // denial-of-service contained "service unavailable", a 503 marker, and the
  // whole page was reported DOWN.
  const questions = Array.from({ length: 20 }, (_, i) => `<h2>Question ${i + 1}: …</h2><button>Show Answer</button>`).join("");
  const html = body(questions + "<p>a denial of service attack aims to render a service unavailable by flooding it with traffic</p>");
  assert.equal(checkContentVerdict("PRACTICE", html, null), "ok");
});

test("rendered content beats every error-word in the question text", () => {
  const questions = Array.from({ length: 5 }, (_, i) => `<h2>Question ${i + 1}: …</h2><button>Show Answer</button>`).join("");
  for (const phrase of ["fatal error", "sqlstate", "mysqli", "database connection", "uncaught exception", "500 internal server error"]) {
    assert.equal(checkContentVerdict("PRACTICE", body(questions + `<p>the exam covers ${phrase} handling</p>`), null), "ok", phrase);
  }
});

test("error markers still decide when nothing rendered", () => {
  // No question blocks => the vocabulary is the only signal, and it counts.
  assert.equal(checkContentVerdict("PRACTICE", body("<p>503 service unavailable</p>"), null), "broken");
  assert.equal(checkContentVerdict("PRACTICE", body("<p>fatal error: mysqli connection refused</p>"), null), "broken");
});

test("a single stray 'Question 1' is not proof of content", () => {
  // Count-based: one template mention must not rescue an error page.
  assert.equal(checkContentVerdict("PRACTICE", "<html><body><h2>Question 1:</h2><p>Could not load this exam.</p></body></html>", null), "broken");
});

test("an empty practice shell is NOT ok just because CSS says 'answer-option'", () => {
  // Regression: answers.oapractice.com returns 200 + ~5KB of layout/CSS for
  // exams that only exist on questions.*. The words "answer"/"option" appear in
  // class names, which satisfied the old substring hints — so a page with zero
  // questions passed as healthy, and the collector built 15 bogus links from it.
  const shell = `<html><body><h1>D322 - Introduction to IT</h1>
    <p>.answer-option[data-astro-cid-r364hnea].correct label { color: green }</p>
    ${"<p>" + "x".repeat(600) + "</p>"}</body></html>`;
  assert.notEqual(checkContentVerdict("PRACTICE", shell, null), "ok");
});

test("timed pages are NOT held to the practice content rule", () => {
  // Timed exams are JS-driven apps: their HTML ships no question markup, so the
  // strict practice rule would wrongly flag all of them.
  const timedApp = `<html><body><h1>Exam</h1><div id="app"></div>
    <p>Start the exam and submit your answers.</p>${"<p>" + "y".repeat(600) + "</p>"}</body></html>`;
  assert.equal(checkContentVerdict("TIMED", timedApp, null), "ok");
});

test("a substantial page missing its markers is degraded, not down", () => {
  assert.equal(checkContentVerdict("PRACTICE", body("<h1>Welcome</h1>"), null), "degraded");
});

test("checkContent stays a boolean view of the verdict", () => {
  assert.equal(checkContent("PRACTICE", body("<h2>Question 1:</h2><button>Show Answer</button>"), null), true);
  assert.equal(checkContent("PRACTICE", "<html><body>Could not load this exam.</body></html>", null), false);
});

// ── manual overrides must beat collected values, per field ─────────────────
test("an edited exam name wins; an un-edited one falls back", () => {
  assert.equal(effectiveName({ examName: "Elsevier (HESI): HESI Admission Assessment - HESI A2", displayName: "HESI A2" }), "HESI A2");
  assert.equal(effectiveName({ examName: "Collected", displayName: null }), "Collected");
  assert.equal(effectiveName({ examName: "Collected", displayName: "   " }), "Collected");
});

test("editing 100 of 8000 exams leaves the other 7900 untouched", () => {
  const exams = Array.from({ length: 8000 }, (_, i) => ({
    examName: `Collected ${i}`,
    displayName: i < 100 ? `Edited ${i}` : null,
  }));
  const names = exams.map(effectiveName);
  assert.equal(names.filter((n) => n.startsWith("Edited")).length, 100);
  assert.equal(names.filter((n) => n.startsWith("Collected")).length, 7900);
});

test("a corrected URL wins per field, leaving the others collected", () => {
  const exam = {
    landingUrl: "https://oapractice.com/wrong",
    practiceBaseUrl: "https://questions.oapractice.com/classes/d310/set1-part1.html",
    timedBaseUrl: "https://onlineexamtest.com/exam_sets/x/set-1",
    contactUrl: "https://oapractice.com/contact",
    landingUrlOverride: "https://oapractice.com/d310",
    practiceUrlOverride: null,
    timedUrlOverride: null,
    contactUrlOverride: null,
  };
  assert.equal(effectiveLanding(exam), "https://oapractice.com/d310");
  assert.equal(effectivePractice(exam), exam.practiceBaseUrl);
  assert.equal(effectiveEntryLinks(exam).studyGuide, "https://oapractice.com/d310");
  assert.equal(hasUrlOverride(exam), true);
  assert.equal(hasUrlOverride({ ...exam, landingUrlOverride: null }), false);
});

// ── channel keys from the automation ───────────────────────────────────────
test("channel keys parse, including odd separators and multi-token codes", () => {
  const cases: [string, string, string | null, string][] = [
    ["OAP_SG_D310", "OAP", "oapractice", "D310"],
    ["NURSING_QA_TEAS", "NURSING", "nursingexamsupport", "TEAS"],
    ["STATE_QA_NY_PCL", "STATE", "stateexamsprep", "NY_PCL"],
    ["OAP_D426", "OAP", "oapractice", "D426"], // content type optional
    ["oag-sg-c720", "OAG", "oaguides", "C720"], // lowercase + dashes
  ];
  for (const [input, channel, site, code] of cases) {
    const p = parseChannelKey(input);
    assert.equal(p.channel, channel, input);
    assert.equal(p.site, site, input);
    assert.equal(p.examCode, code, input);
  }
  assert.equal(parseChannelKey("XYZ_SG_D1").site, null, "unknown channel resolves to no site");
});

// ── QR filenames ───────────────────────────────────────────────────────────
test("QR filenames follow the agreed per-channel convention", () => {
  assert.equal(qrFilenameBase("OAP", "d236", "ignored"), "QR_D236_oaP");
  assert.equal(qrFilenameBase("OAG", "D236", "ignored"), "QR_D236_oaG");
  assert.equal(qrFilenameBase("NURSING", "HESIA2", "HESI Fundamentals of Nursing"), "QR_HESI_Fundamentals_of_Nursing_Nursing");
  assert.equal(qrFilenameBase("STATE", "NYPCL", "New York Property & Casualty License"), "QR_New_York_Property_Casualty_License_State");
});

// ── link enumeration for both practice URL formats ─────────────────────────
test("both practice URL formats enumerate 5 sets x 3 parts correctly", () => {
  const pathBase: PracticeBase = {
    variant: "questions",
    baseUrl: "https://questions.oapractice.com/classes/c720/set1-part1.html",
    format: "path",
    sets: 5,
    parts: 3,
  };
  const queryBase: PracticeBase = {
    variant: "questions",
    baseUrl: "https://questions.oapractice.com/practice-questions/C/?ec=D426&set=1&part=1",
    format: "query",
    sets: 5,
    parts: 3,
  };
  for (const base of [pathBase, queryBase]) {
    const links = enumerateLinks({ landingUrl: "https://oapractice.com/x", practices: [base], timedUrl: null, contactUrl: null, timedSetsCount: 0 });
    assert.equal(links.filter((l) => l.type === "PRACTICE").length, 15, base.format);
  }
  const pathLinks = enumerateLinks({ landingUrl: "https://x/", practices: [pathBase], timedUrl: null, contactUrl: null, timedSetsCount: 0 });
  assert.equal(
    pathLinks.find((l) => l.type === "PRACTICE" && l.setNo === 3 && l.part === 2)?.url,
    "https://questions.oapractice.com/classes/c720/set3-part2.html",
  );
  const queryLinks = enumerateLinks({ landingUrl: "https://x/", practices: [queryBase], timedUrl: null, contactUrl: null, timedSetsCount: 0 });
  assert.equal(
    queryLinks.find((l) => l.type === "PRACTICE" && l.setNo === 3 && l.part === 2)?.url,
    "https://questions.oapractice.com/practice-questions/C/?ec=D426&set=3&part=2",
  );
});

test("timed sets rewrite the trailing /set-N", () => {
  const links = enumerateLinks({
    landingUrl: "https://x/",
    practices: [],
    timedUrl: "https://onlineexamtest.com/exam_sets/ops-c720/set-1",
    contactUrl: null,
    timedSetsCount: 5,
  });
  const timed = links.filter((l) => l.type === "TIMED");
  assert.equal(timed.length, 5);
  assert.equal(timed[4].url, "https://onlineexamtest.com/exam_sets/ops-c720/set-5");
});
