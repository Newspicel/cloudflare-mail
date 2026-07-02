import { describe, expect, it } from "vitest";
import { isBlockedHost } from "../src/ssrf.ts";

describe("isBlockedHost — hostnames", () => {
  it.each(["localhost", "sub.localhost", "printer.local", "db.internal"])("blocks %s", (h) => {
    expect(isBlockedHost(h)).toBe(true);
  });

  it.each(["example.com", "cdn.example.org", "images.mail.test"])("allows %s", (h) => {
    expect(isBlockedHost(h)).toBe(false);
  });
});

describe("isBlockedHost — IPv4 literals", () => {
  it.each([
    "127.0.0.1",
    "127.1", // short form
    "0x7f000001", // hex
    "2130706433", // decimal
    "017700000001", // octal
    "0.0.0.0",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "224.0.0.1", // multicast
  ])("blocks %s", (h) => {
    expect(isBlockedHost(h)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.32.0.1",
    "100.128.0.1",
  ])("allows %s", (h) => {
    expect(isBlockedHost(h)).toBe(false);
  });
});

describe("isBlockedHost — plain IPv6", () => {
  it.each([
    "::",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1", // expanded loopback
    "fe80::1", // link-local
    "fe80::a%eth0", // link-local with zone index
    "febf::1", // still fe80::/10
    "fc00::1", // ULA
    "fd12:3456:789a::1", // ULA
    "ff02::1", // multicast
  ])("blocks %s", (h) => {
    expect(isBlockedHost(h)).toBe(true);
  });

  it.each([
    "2606:4700::6810:84e5",
    "2001:4860:4860::8888",
    "2a00:1450:4001:82f::200e",
    "fe00::1", // not in fe80::/10
  ])("allows %s", (h) => {
    expect(isBlockedHost(h)).toBe(false);
  });

  it.each([
    "::1::2",
    "1:2:3:4:5:6:7:8:9",
    "abcd::efgh",
    "::ffff:1.2.3",
    "::ffff:1.2.3.999",
  ])("blocks malformed literal %s", (h) => {
    expect(isBlockedHost(h)).toBe(true);
  });
});

describe("isBlockedHost — IPv4-mapped/compat IPv6", () => {
  it.each([
    "::ffff:127.0.0.1", // dotted mapped loopback
    "::ffff:7f00:1", // hex mapped loopback
    "::ffff:a00:1", // hex mapped 10.0.0.1
    "::ffff:10.0.0.1",
    "::ffff:c0a8:101", // hex mapped 192.168.1.1
    "::ffff:192.168.1.1",
    "::ffff:a9fe:a9fe", // hex mapped 169.254.169.254
    "::ffff:169.254.169.254",
    "::7f00:1", // IPv4-compatible loopback
    "::127.0.0.1",
  ])("blocks %s", (h) => {
    expect(isBlockedHost(h)).toBe(true);
  });

  it.each([
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "::ffff:1.1.1.1",
  ])("allows mapped public %s", (h) => {
    expect(isBlockedHost(h)).toBe(false);
  });
});

describe("isBlockedHost — NAT64 (64:ff9b::/96)", () => {
  it.each([
    "64:ff9b::127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b::a00:1", // 10.0.0.1
    "64:ff9b::169.254.169.254",
  ])("blocks %s", (h) => {
    expect(isBlockedHost(h)).toBe(true);
  });

  it.each(["64:ff9b::8.8.8.8", "64:ff9b::808:808"])("allows NAT64 public %s", (h) => {
    expect(isBlockedHost(h)).toBe(false);
  });
});
