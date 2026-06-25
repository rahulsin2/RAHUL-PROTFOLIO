import "server-only";
import { getIntegration } from "./store";
import type { Contributions, ContributionDay } from "../types";

const EMPTY: Contributions = { total: 0, weeks: [], range: "" };

const levelMap: Record<string, ContributionDay["level"]> = {
  NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4,
};

function toWeeks(days: ContributionDay[]): ContributionDay[][] {
  const weeks: ContributionDay[][] = [];
  let week: ContributionDay[] = [];
  for (const day of days) {
    const dow = new Date(day.date + "T12:00:00Z").getUTCDay(); // 0=Sun
    if (dow === 0 && week.length) { weeks.push(week); week = []; }
    week.push(day);
  }
  if (week.length) weeks.push(week);
  return weeks;
}

/** GraphQL path — requires a token. */
async function fetchWithToken(token: string, username: string): Promise<Contributions> {
  const query = `query($login:String!){
    user(login:$login){
      contributionsCollection{
        contributionCalendar{
          totalContributions
          weeks{ contributionDays{ date contributionCount contributionLevel } }
        }
      }
    }
  }`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": `${username}-portfolio`,
    },
    body: JSON.stringify({ query, variables: { login: username } }),
    next: { revalidate: 1800 },
  });
  if (!res.ok) return EMPTY;
  const json = await res.json();
  const cal = json?.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) return EMPTY;

  const weeks: ContributionDay[][] = cal.weeks.map(
    (w: { contributionDays: { date: string; contributionCount: number; contributionLevel: string }[] }) =>
      w.contributionDays.map((d) => ({
        date: d.date,
        count: d.contributionCount,
        level: levelMap[d.contributionLevel] ?? 0,
      })),
  );
  const first = weeks[0]?.[0]?.date?.slice(0, 4) ?? "";
  const last = weeks.at(-1)?.at(-1)?.date?.slice(0, 4) ?? "";
  const range = first && last ? (first === last ? first : `${first}–${last.slice(2)}`) : "";
  return { total: cal.totalContributions, weeks, range };
}

/** Public no-auth path via github-contributions-api.jogruber.de */
async function fetchPublic(username: string): Promise<Contributions> {
  const res = await fetch(
    `https://github-contributions-api.jogruber.de/v4/${username}?y=last`,
    { next: { revalidate: 1800 } },
  );
  if (!res.ok) return EMPTY;
  const json = await res.json() as {
    total: Record<string, number>;
    contributions: { date: string; count: number; level: number }[];
  };
  if (!json.contributions?.length) return EMPTY;

  const days: ContributionDay[] = json.contributions.map((d) => ({
    date: d.date,
    count: d.count,
    level: Math.min(d.level, 4) as ContributionDay["level"],
  }));
  const weeks = toWeeks(days);
  const total = Object.values(json.total).reduce((a, b) => a + b, 0);
  const first = days[0]?.date.slice(0, 4) ?? "";
  const last = days.at(-1)?.date.slice(0, 4) ?? "";
  const range = first && last ? (first === last ? first : `${first}–${last.slice(2)}`) : "";
  return { total, weeks, range };
}

/**
 * Live GitHub contribution graph.
 * Uses GraphQL (authenticated) when a token is available, falls back to the
 * public contributions API so the graph renders even without a token.
 */
export async function getContributions(fallbackUsername?: string): Promise<Contributions> {
  const integ = await getIntegration("github");
  const token = integ?.access_token ?? process.env.GITHUB_TOKEN ?? "";
  const username = (integ?.meta?.username as string) ?? process.env.GITHUB_USERNAME ?? fallbackUsername ?? "";
  if (!username) return EMPTY;

  try {
    if (token) return await fetchWithToken(token, username);
    return await fetchPublic(username);
  } catch {
    return EMPTY;
  }
}
