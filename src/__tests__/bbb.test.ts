// src/__tests__/bbb.test.ts
import { describe, it, expect } from "bun:test";
import { buildChecksum, buildApiUrl, parseRecordingsXml, buildWebcamsUrl } from "../lib/bbb";

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
