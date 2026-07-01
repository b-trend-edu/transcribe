// src/__tests__/bbb.test.ts
import { describe, it, expect } from "bun:test";
import {
  buildChecksum,
  buildApiUrl,
  parseRecordingsXml,
  buildWebcamsUrl,
  uploadCaptionTrack,
  parseRecordingMetadataXml,
} from "../lib/bbb";

describe("buildChecksum", () => {
  it("creates SHA-1 checksum from call name, query string, and secret", () => {
    const result = buildChecksum("getRecordings", "state=published", "my-secret");
    expect(result).toBeString();
    expect(result).toHaveLength(40);
  });
});

describe("buildApiUrl", () => {
  it("builds full API URL with checksum", () => {
    const url = buildApiUrl(
      "https://vroom.b-trend.digital/bigbluebutton",
      "getRecordings",
      "state=published",
      "my-secret"
    );
    expect(url).toStartWith(
      "https://vroom.b-trend.digital/bigbluebutton/api/getRecordings?state=published&checksum="
    );
  });
});

describe("buildWebcamsUrl", () => {
  const playback = "https://vroom.b-trend.digital/playback/presentation/2.3/rec-abc123";

  it("maps a playback page URL to the webcams media on the same origin", () => {
    expect(buildWebcamsUrl(playback, "rec-abc123")).toBe(
      "https://vroom.b-trend.digital/presentation/rec-abc123/video/webcams.webm"
    );
  });

  it("supports the mp4 fallback extension", () => {
    expect(buildWebcamsUrl(playback, "rec-abc123", "mp4")).toBe(
      "https://vroom.b-trend.digital/presentation/rec-abc123/video/webcams.mp4"
    );
  });

  it("ignores the playback path/port-less origin details and keeps only scheme+host", () => {
    expect(buildWebcamsUrl("https://bbb.example.com:8443/playback/presentation/2.3/x-1", "x-1")).toBe(
      "https://bbb.example.com:8443/presentation/x-1/video/webcams.webm"
    );
  });
});

describe("parseRecordingMetadataXml", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<recording>
  <id>3c97908bb2dc4f794914776d639405709479c3da-1490721543626</id>
  <state>published</state>
  <published>true</published>
  <start_time>1490721543626</start_time>
  <end_time>1490721560835</end_time>
  <participants>1</participants>
  <meta>
    <meetingName>Falck Weekly</meetingName>
    <meetingId>falck-room-01</meetingId>
    <isBreakout>false</isBreakout>
  </meta>
  <playback>
    <format>presentation</format>
    <link>https://vroom.b-trend.digital/playback/presentation/2.3/3c97908bb2dc4f794914776d639405709479c3da-1490721543626</link>
    <duration>9807</duration>
  </playback>
</recording>`;

  it("extracts meeting name, ms->s timestamps, and the playback link", () => {
    const meta = parseRecordingMetadataXml(xml);
    expect(meta.meetingName).toBe("Falck Weekly");
    expect(meta.meetingId).toBe("falck-room-01");
    // start_time/end_time are epoch ms in the file; returned as seconds
    expect(meta.startTime).toBe(1490721543);
    expect(meta.endTime).toBe(1490721560);
    expect(meta.playbackUrl).toBe(
      "https://vroom.b-trend.digital/playback/presentation/2.3/3c97908bb2dc4f794914776d639405709479c3da-1490721543626"
    );
  });

  it("returns undefined fields for empty/garbage metadata rather than throwing", () => {
    expect(parseRecordingMetadataXml("<recording></recording>")).toEqual({
      meetingName: undefined,
      meetingId: undefined,
      startTime: undefined,
      endTime: undefined,
      playbackUrl: undefined,
    });
  });
});

describe("uploadCaptionTrack", () => {
  it("POSTs the VTT to putRecordingTextTrack with a checksum and file part", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        "<response><returncode>SUCCESS</returncode><messageKey>upload_text_track_success</messageKey></response>"
      );
    }) as unknown as typeof fetch;

    try {
      const res = await uploadCaptionTrack(
        "https://vroom.b-trend.digital/bigbluebutton",
        "my-secret",
        "rec-abc123",
        "de",
        "German",
        "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhallo\n"
      );

      expect(res.success).toBe(true);
      expect(res.messageKey).toBe("upload_text_track_success");
      expect(calls).toHaveLength(1);

      const { url, init } = calls[0];
      expect(url).toContain("/api/putRecordingTextTrack?");
      expect(url).toContain("recordID=rec-abc123");
      expect(url).toContain("kind=captions");
      expect(url).toContain("lang=de");
      expect(url).toContain("checksum=");
      expect(init.method).toBe("POST");
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.body as FormData).has("file")).toBe(true);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("reports failure when BBB returns FAILED", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        "<response><returncode>FAILED</returncode><messageKey>invalidLang</messageKey></response>"
      )) as unknown as typeof fetch;
    try {
      const res = await uploadCaptionTrack("https://x/bigbluebutton", "s", "r", "en", "English", "WEBVTT\n");
      expect(res.success).toBe(false);
      expect(res.messageKey).toBe("invalidLang");
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("parseRecordingsXml", () => {
  it("parses BBB getRecordings XML response into recording objects", () => {
    const xml = `
      <response>
        <returncode>SUCCESS</returncode>
        <recordings>
          <recording>
            <recordID>rec-abc123</recordID>
            <meetingID>meet-1</meetingID>
            <name>Test Meeting</name>
            <startTime>1700000000000</startTime>
            <endTime>1700003600000</endTime>
            <playback>
              <format>
                <type>presentation</type>
                <url>https://vroom.b-trend.digital/playback/presentation/2.3/rec-abc123</url>
              </format>
            </playback>
          </recording>
        </recordings>
      </response>
    `;
    const result = parseRecordingsXml(xml);
    expect(result).toHaveLength(1);
    expect(result[0].recordId).toBe("rec-abc123");
    expect(result[0].meetingId).toBe("meet-1");
    expect(result[0].meetingName).toBe("Test Meeting");
    expect(result[0].videoUrl).toContain("rec-abc123");
  });

  it("returns empty array when no recordings", () => {
    const xml = `
      <response>
        <returncode>SUCCESS</returncode>
        <recordings></recordings>
      </response>
    `;
    const result = parseRecordingsXml(xml);
    expect(result).toEqual([]);
  });

  it("filters out recordings without a playback URL", () => {
    const xml = `
      <response>
        <returncode>SUCCESS</returncode>
        <recordings>
          <recording>
            <recordID>rec-no-video</recordID>
            <meetingID>meet-2</meetingID>
            <name>No Video</name>
            <startTime>1700000000000</startTime>
            <endTime>1700003600000</endTime>
            <playback></playback>
          </recording>
        </recordings>
      </response>
    `;
    const result = parseRecordingsXml(xml);
    expect(result).toEqual([]);
  });
});
