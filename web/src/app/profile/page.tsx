'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Navbar from '../../components/Navbar';
import { useAuth } from '../../context/AuthContext';
import { getApiBaseUrl } from '@/lib/apiBase';
import { authFetch } from '@/lib/authFetch';

type Role = 'CITIZEN' | 'MODERATOR' | 'LAW_ENFORCEMENT' | 'ADMIN';
type Sex = 'MALE' | 'FEMALE' | 'UNDISCLOSED';

type ProfilePayload = {
    id: string;
    role: Role;
    email: string | null;
    phone: string | null;
    fullName: string | null;
    age: number | null;
    sex: Sex;
    avatarUrl: string | null;
    notificationPrefs: Record<string, boolean>;
    witnessNotificationsEnabled?: boolean;
    witnessAlertLatitude?: number | null;
    witnessAlertLongitude?: number | null;
};

const ROLE_PREFS: Record<Role, Array<{ key: string; label: string }>> = {
    CITIZEN: [
        { key: 'receiveCrimeResolutionNotifications', label: 'Receive crime resolution notifications' },
        { key: 'receiveSafeRouteAlerts', label: 'Receive safe route alerts' },
    ],
    MODERATOR: [
        { key: 'receiveNewReportQueueNotifications', label: 'Receive new report queue notifications' },
        { key: 'receiveEscalationAlerts', label: 'Receive escalation alerts' },
        { key: 'receiveCrimeResolutionNotifications', label: 'Receive crime resolution notifications' },
    ],
    LAW_ENFORCEMENT: [
        { key: 'receiveCctvMatchAlerts', label: 'Receive CCTV match alerts' },
        { key: 'receiveHotspotSpikeAlerts', label: 'Receive hotspot spike alerts' },
        { key: 'receiveEscalationAlerts', label: 'Receive escalation alerts' },
    ],
    ADMIN: [
        { key: 'receiveCrimeResolutionNotifications', label: 'Receive crime resolution notifications' },
        { key: 'receiveSafeRouteAlerts', label: 'Receive safe route alerts' },
        { key: 'receiveNewReportQueueNotifications', label: 'Receive new report queue notifications' },
        { key: 'receiveEscalationAlerts', label: 'Receive escalation alerts' },
        { key: 'receiveCctvMatchAlerts', label: 'Receive CCTV match alerts' },
        { key: 'receiveHotspotSpikeAlerts', label: 'Receive hotspot spike alerts' },
    ],
};

export default function ProfilePage() {
    const { token, user, loading: authLoading, logout } = useAuth();
    const [profile, setProfile] = useState<ProfilePayload | null>(null);
    const [fullName, setFullName] = useState('');
    const [age, setAge] = useState('');
    const [sex, setSex] = useState<Sex>('UNDISCLOSED');
    const [prefs, setPrefs] = useState<Record<string, boolean>>({});
    const [avatarUploading, setAvatarUploading] = useState(false);
    const [lat, setLat] = useState('');
    const [lng, setLng] = useState('');
    const [witnessNotificationsEnabled, setWitnessNotificationsEnabled] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState('');

    useEffect(() => {
        if (!token || authLoading) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await authFetch(`${getApiBaseUrl()}/api/profile`, {}, token);
                const data = await res.json().catch(() => ({}));
                if (!res.ok || cancelled) return;
                const u: ProfilePayload | undefined = data.profile;
                if (!u) return;
                setProfile(u);
                setFullName(u.fullName ?? '');
                setAge(u.age != null ? String(u.age) : '');
                setSex((u.sex || 'UNDISCLOSED') as Sex);
                setPrefs(u.notificationPrefs || {});
                setWitnessNotificationsEnabled(u.witnessNotificationsEnabled !== false);
                setLat(u.witnessAlertLatitude != null ? String(u.witnessAlertLatitude) : '');
                setLng(u.witnessAlertLongitude != null ? String(u.witnessAlertLongitude) : '');
            } catch {
                /* ignore */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [token, authLoading]);

    const updatePref = (key: string, value: boolean) => {
        setPrefs((prev) => ({ ...prev, [key]: value }));
    };

    const save = async () => {
        if (!token) return;
        setSaving(true);
        setMessage('');
        try {
            const la = lat.trim() === '' ? null : parseFloat(lat);
            const lo = lng.trim() === '' ? null : parseFloat(lng);
            const body: Record<string, unknown> = {
                fullName,
                age: age.trim() === '' ? null : Number(age),
                sex,
                notificationPrefs: prefs,
                witnessNotificationsEnabled,
            };
            if (la === null && lo === null) {
                body.witnessAlertLatitude = null;
                body.witnessAlertLongitude = null;
            } else if (la !== null && lo !== null && !Number.isNaN(la) && !Number.isNaN(lo)) {
                body.witnessAlertLatitude = la;
                body.witnessAlertLongitude = lo;
            } else if (lat.trim() !== '' || lng.trim() !== '') {
                setMessage('Enter both latitude and longitude, or leave both empty.');
                setSaving(false);
                return;
            }

            const res = await authFetch(`${getApiBaseUrl()}/api/profile`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }, token);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Save failed');
            const u: ProfilePayload | undefined = data.profile;
            if (u) {
                setProfile(u);
                setFullName(u.fullName ?? '');
                setAge(u.age != null ? String(u.age) : '');
                setSex((u.sex || 'UNDISCLOSED') as Sex);
                setPrefs(u.notificationPrefs || {});
                setWitnessNotificationsEnabled(u.witnessNotificationsEnabled !== false);
                setLat(u.witnessAlertLatitude != null ? String(u.witnessAlertLatitude) : '');
                setLng(u.witnessAlertLongitude != null ? String(u.witnessAlertLongitude) : '');
            }
            setMessage('Profile saved.');
        } catch (e: any) {
            setMessage(e?.message || 'Save failed');
        } finally {
            setSaving(false);
        }
    };

    const uploadAvatar = async (file: File) => {
        if (!token) return;
        setAvatarUploading(true);
        setMessage('');
        try {
            const fd = new FormData();
            fd.append('avatar', file);
            const res = await authFetch(`${getApiBaseUrl()}/api/profile/avatar`, {
                method: 'POST',
                body: fd,
            }, token);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Avatar upload failed');
            setProfile((prev) =>
                prev ? { ...prev, avatarUrl: data?.user?.avatarUrl ?? prev.avatarUrl } : prev,
            );
            setMessage('Avatar updated.');
        } catch (e: any) {
            setMessage(e?.message || 'Avatar upload failed');
        } finally {
            setAvatarUploading(false);
        }
    };

    if (!authLoading && !token) {
        return (
            <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
                <Navbar />
                <div className="max-w-lg mx-auto px-4 py-16 text-center">
                    <p className="text-slate-400 mb-4">Sign in to manage your profile.</p>
                    <Link href="/login" className="text-indigo-400 font-semibold hover:text-indigo-300">
                        Sign in
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
            <Navbar />
            <div className="max-w-lg mx-auto px-4 py-10">
                <h1 className="text-2xl font-bold text-slate-100 mb-2">Profile</h1>
                <p className="text-sm text-slate-400 mb-8">
                    {user?.email || user?.phone || 'Signed in'} — manage account details and role-specific notification
                    preferences.
                </p>

                <div className="space-y-6 bg-slate-900 border border-slate-800 rounded-2xl p-6">
                    <div className="flex items-center gap-4">
                        {profile?.avatarUrl ? (
                            <img
                                src={profile.avatarUrl}
                                alt="Avatar"
                                className="w-16 h-16 rounded-full object-cover border border-slate-700"
                            />
                        ) : (
                            <div className="w-16 h-16 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-400 text-xs">
                                Avatar
                            </div>
                        )}
                        <div>
                            <label className="text-xs text-slate-500 block mb-1">Profile picture (JPG/PNG, max 2MB)</label>
                            <input
                                type="file"
                                accept="image/jpeg,image/png"
                                onChange={(e) => {
                                    const f = e.target.files?.[0];
                                    if (f) void uploadAvatar(f);
                                }}
                                className="text-xs text-slate-300"
                                disabled={avatarUploading}
                            />
                        </div>
                    </div>

                    <div>
                        <label className="text-xs text-slate-500">Full name</label>
                        <input
                            value={fullName}
                            onChange={(e) => setFullName(e.target.value)}
                            className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                            placeholder="Your full name"
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="text-xs text-slate-500">Age</label>
                            <input
                                value={age}
                                onChange={(e) => setAge(e.target.value)}
                                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                                placeholder="Age"
                                type="number"
                                min={0}
                                max={120}
                            />
                        </div>
                        <div>
                            <label className="text-xs text-slate-500">Sex</label>
                            <select
                                value={sex}
                                onChange={(e) => setSex(e.target.value as Sex)}
                                className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                            >
                                <option value="MALE">Male</option>
                                <option value="FEMALE">Female</option>
                                <option value="UNDISCLOSED">Undisclosed</option>
                            </select>
                        </div>
                    </div>

                    <div>
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                            Notification preferences
                        </p>
                        <div className="space-y-2">
                            {(ROLE_PREFS[(profile?.role || user?.role || 'CITIZEN') as Role] || []).map((p) => (
                                <label key={p.key} className="flex items-center gap-3 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={Boolean(prefs[p.key])}
                                        onChange={(e) => updatePref(p.key, e.target.checked)}
                                        className="rounded border-slate-600 text-indigo-600 focus:ring-indigo-500"
                                    />
                                    <span className="text-sm text-slate-200">{p.label}</span>
                                </label>
                            ))}
                        </div>
                    </div>

                    <label className="flex items-center gap-3 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={witnessNotificationsEnabled}
                            onChange={(e) => setWitnessNotificationsEnabled(e.target.checked)}
                            className="rounded border-slate-600 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-sm text-slate-200">Allow witness notifications (nearby reported incidents)</span>
                    </label>

                    <div>
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Witness alert location</p>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-xs text-slate-500">Latitude</label>
                                <input
                                    value={lat}
                                    onChange={(e) => setLat(e.target.value)}
                                    className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                                    placeholder="e.g. 24.8607"
                                />
                            </div>
                            <div>
                                <label className="text-xs text-slate-500">Longitude</label>
                                <input
                                    value={lng}
                                    onChange={(e) => setLng(e.target.value)}
                                    className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                                    placeholder="e.g. 67.0011"
                                />
                            </div>
                        </div>
                        <p className="text-xs text-slate-500 mt-2">Clear both fields to remove your alert point.</p>
                    </div>

                    <button
                        type="button"
                        disabled={saving || avatarUploading}
                        onClick={() => void save()}
                        className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold"
                    >
                        {saving ? 'Saving…' : 'Save settings'}
                    </button>
                    {message ? <p className="text-sm text-slate-400">{message}</p> : null}
                </div>
            </div>
        </div>
    );
}
