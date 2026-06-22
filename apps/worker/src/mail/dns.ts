export interface DomainHealth {
  spfOk: boolean;
  dkimOk: boolean;
  dmarcOk: boolean;
}

const DOH_URL = "https://cloudflare-dns.com/dns-query";
const CF_DKIM_SELECTORS = ["cf2024-1", "cf2024-2", "cf2024-3"];

type DohRecord = { type: number; data: string };
type DohResponse = { Answer?: DohRecord[] };

export async function dohQuery(name: string, type: "TXT" | "CNAME" | "A"): Promise<string[]> {
  const url = new URL(DOH_URL);
  url.searchParams.set("name", name);
  url.searchParams.set("type", type);
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/dns-json" },
    cf: { cacheTtl: 60, cacheEverything: true },
  } as RequestInit);
  if (!res.ok) return [];
  const data = (await res.json()) as DohResponse;
  return (data.Answer ?? []).map((a) => unquoteTxt(a.data));
}

function unquoteTxt(value: string): string {
  return value
    .split(/(?<!\\)"\s+"/)
    .map((chunk) => chunk.replace(/^"|"$/g, "").replace(/\\"/g, '"'))
    .join("");
}

export async function checkDomainHealth(domain: string): Promise<DomainHealth> {
  const [apexTxt, dmarcTxt, dkimAnswers] = await Promise.all([
    dohQuery(domain, "TXT"),
    dohQuery(`_dmarc.${domain}`, "TXT"),
    Promise.all(
      CF_DKIM_SELECTORS.flatMap((sel) => [
        dohQuery(`${sel}._domainkey.${domain}`, "CNAME"),
        dohQuery(`${sel}._domainkey.${domain}`, "TXT"),
      ]),
    ).then((all) => all.flat()),
  ]);

  return {
    spfOk: apexTxt.some((r) => /v=spf1\b/i.test(r) && /_spf\.mx\.cloudflare\.net/i.test(r)),
    dmarcOk: dmarcTxt.some((r) => /v=DMARC1\b/i.test(r)),
    dkimOk: dkimAnswers.some((r) => r.length > 0),
  };
}
