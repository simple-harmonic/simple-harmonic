"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "sh:user-profile";

interface UserProfile {
  displayName: string;
  role: string;
}

function loadProfile(): UserProfile {
  if (typeof window === "undefined") return { displayName: "You", role: "Founder" };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as UserProfile;
  } catch { /* ignore */ }
  return { displayName: "You", role: "Founder" };
}

function saveProfile(profile: UserProfile) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
}

export default function ProfilePage() {
  const [profile, setProfile] = useState<UserProfile>({ displayName: "You", role: "Founder" });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setProfile(loadProfile());
  }, []);

  const handleSave = () => {
    const trimmed = {
      displayName: profile.displayName.trim() || "You",
      role: profile.role.trim() || "Founder",
    };
    saveProfile(trimmed);
    setProfile(trimmed);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const inputClass =
    "w-full bg-bg border border-border rounded-md px-3 py-2.5 text-[14px] text-fg focus:outline-none focus:border-brand transition-colors";

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[480px] mx-auto px-6 py-10">
        <h1 className="text-lg font-semibold tracking-tight mb-1">Profile</h1>
        <p className="text-[13px] text-fg-faint mb-8">
          How you appear to your agents and in the sidebar.
        </p>

        <div className="flex flex-col gap-5">
          {/* Avatar preview */}
          <div className="flex items-center gap-4 mb-2">
            <div className="w-12 h-12 rounded-full bg-brand/15 text-brand flex items-center justify-center text-[18px] font-semibold shrink-0">
              {(profile.displayName || "Y")[0].toUpperCase()}
            </div>
            <div>
              <div className="text-[14px] font-medium text-fg">{profile.displayName || "You"}</div>
              <div className="text-[12px] text-fg-faint font-mono">{profile.role || "Founder"}</div>
            </div>
          </div>

          <div>
            <label htmlFor="displayName" className="block text-[11px] text-fg-faint font-mono uppercase tracking-wider mb-1.5">
              Display Name
            </label>
            <input
              id="displayName"
              className={inputClass}
              value={profile.displayName}
              onChange={(e) => setProfile((p) => ({ ...p, displayName: e.target.value }))}
              placeholder="You"
            />
          </div>

          <div>
            <label htmlFor="role" className="block text-[11px] text-fg-faint font-mono uppercase tracking-wider mb-1.5">
              Role
            </label>
            <input
              id="role"
              className={inputClass}
              value={profile.role}
              onChange={(e) => setProfile((p) => ({ ...p, role: e.target.value }))}
              placeholder="Founder"
            />
          </div>

          <div className="flex items-center gap-3 mt-2">
            <button
              type="button"
              onClick={handleSave}
              className="bg-brand text-white text-[14px] font-medium px-5 py-2.5 rounded-md cursor-pointer"
            >
              Save
            </button>
            {saved && (
              <span className="text-[12px] text-running font-mono">Saved</span>
            )}
          </div>
        </div>

        <p className="text-[11px] text-fg-faint font-mono mt-10">
          v0.0 preview: profile is stored locally. Account system comes in v0.1.
        </p>
      </div>
    </div>
  );
}
