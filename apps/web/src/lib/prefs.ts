import { parseUserPrefs, type UserPrefs } from "@cfmail/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authClient } from "./auth-client.ts";
import { type MeUser, meQuery } from "./queries.ts";
import { type DateTimeFmt, resolveDateTimeFmt } from "./time.ts";

type MeData = { user: MeUser | null };

/**
 * Read/write the current user's app preferences. Prefs ride on the Better Auth
 * session user (see auth.ts additionalFields), so reads come from `meQuery` and
 * writes go through `authClient.updateUser({ preferences })`.
 */
export function useUserPrefs() {
  const qc = useQueryClient();
  const { data: meData } = useQuery(meQuery);
  const prefs = parseUserPrefs(meData?.user?.preferences);

  const mutation = useMutation({
    mutationFn: async (next: UserPrefs) => {
      const json = JSON.stringify(next);
      const res = await authClient.updateUser({ preferences: json });
      if (res.error) throw new Error(res.error.message ?? "Failed to save preferences");
      return json;
    },
    // Write straight into the cache rather than refetching: the session cookie
    // cache (auth.ts) can lag ~60s, and this client is the only writer.
    onSuccess: (json) => {
      qc.setQueryData<MeData>(meQuery.queryKey, (old) =>
        old?.user ? { ...old, user: { ...old.user, preferences: json } } : old,
      );
    },
  });

  /** Merge a partial change into the current prefs and persist. */
  const setPrefs = (patch: Partial<UserPrefs>) => mutation.mutateAsync({ ...prefs, ...patch });

  return { prefs, setPrefs, saving: mutation.isPending };
}

/** The current user's resolved date/time formatting prefs (see lib/time.ts). */
export function useDateTimeFmt(): DateTimeFmt {
  const { dateFormat, timeFormat } = useUserPrefs().prefs;
  return resolveDateTimeFmt({ dateFormat, timeFormat });
}
