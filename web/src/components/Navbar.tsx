'use client';

import { ShieldAlert, LogOut, User as UserIcon, Shield, Siren, Bell, Camera, UserSearch, Database, Trash2, AlertOctagon, Menu, X, Map, Route, FileWarning, ThumbsUp, Settings, CheckCircle } from 'lucide-react';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useAuth } from '../context/AuthContext';
import { useRouter } from 'next/navigation';
import CriminalMatchAlert from './CriminalMatchAlert';
import { getApiBaseUrl } from '@/lib/apiBase';
import { authFetch } from '@/lib/authFetch';

const roleBadge: Record<string, { label: string; className: string }> = {
    CITIZEN: { label: 'Citizen', className: 'bg-blue-500/10 text-blue-400 border-blue-500/20' },
    MODERATOR: { label: 'Moderator', className: 'bg-purple-500/10 text-purple-400 border-purple-500/20' },
    LAW_ENFORCEMENT: { label: 'Inspector', className: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
    ADMIN: { label: 'Admin', className: 'bg-rose-500/10 text-rose-400 border-rose-500/20' },
};

export default function Navbar() {
    const { user, loading, token, logout } = useAuth();
    const router = useRouter();

    const [notifications, setNotifications] = useState<any[]>([]);
    const [showNotifs, setShowNotifs] = useState(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

    useEffect(() => {
        if (!token) return;
        const controller = new AbortController();
        const fetchNotifs = async () => {
            try {
                const res = await authFetch(
                    `${getApiBaseUrl()}/api/notifications`,
                    { signal: controller.signal },
                    token,
                );
                if (!res.ok) return;
                const data = await res.json();
                if (data.notifications) setNotifications(data.notifications);
            } catch {
                // Keep notification UI stable if API is temporarily unreachable.
            }
        };
        void fetchNotifs();
        const interval = setInterval(() => {
            void fetchNotifs();
        }, 30000);
        return () => {
            controller.abort();
            clearInterval(interval);
        };
    }, [token]);

    const markAsRead = async (id: string) => {
        try {
            await authFetch(`${getApiBaseUrl()}/api/notifications/${id}/read`, { method: 'POST' }, token);
            setNotifications(prev => prev.map(n => n.id === id ? { ...n, isRead: true } : n));
        } catch {}
    };

    const deleteNotification = async (id: string) => {
        try {
            await authFetch(`${getApiBaseUrl()}/api/notifications/${id}`, { method: 'DELETE' }, token);
            setNotifications(prev => prev.filter(n => n.id !== id));
        } catch {}
    };

    const clearNotifications = async () => {
        try {
            await authFetch(`${getApiBaseUrl()}/api/notifications`, { method: 'DELETE' }, token);
            setNotifications([]);
            setShowNotifs(false);
        } catch {}
    };

    const unreadCount = notifications.filter(n => !n.isRead).length;

    const handleLogout = () => {
        logout();
        router.push('/login');
    };

    const canUseCitizenRouteTools =
        !user || user.role === 'CITIZEN' || user.role === 'ADMIN';
    const role = user?.role;

    return (
        <>
            <CriminalMatchAlert />
            <nav className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md sticky top-0 z-[2000]">
                <div className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-6 h-14 flex items-center justify-between gap-2">
                    {/* Logo */}
                <Link href="/" className="flex items-center space-x-1.5 shrink-0">
                    <ShieldAlert className="w-5 h-5 lg:w-6 lg:h-6 text-rose-500" />
                    <span className="font-bold text-base lg:text-lg tracking-tight text-slate-100">
                        Citizen<span className="text-rose-500">watch</span>
                    </span>
                </Link>

                {/* Mobile menu button */}
                <button
                    onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                    className="md:hidden p-2 text-slate-400 hover:text-white transition-colors"
                >
                    {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
                </button>

                {/* Center nav links */}
                <div className={`${mobileMenuOpen ? 'flex' : 'hidden'} md:flex flex-col md:flex-row md:flex-nowrap items-start md:items-center gap-1 md:gap-1.5 absolute md:relative top-14 md:top-0 left-0 right-0 md:left-auto md:right-auto bg-slate-900 md:bg-transparent border-b border-slate-800 md:border-0 p-4 md:p-0 z-40 md:flex-1 md:ml-3 md:justify-start md:overflow-x-auto`}>
                    <Link href="/" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                        <Map className="w-3.5 h-3.5" />
                        Live Map
                    </Link>
                    {role === 'LAW_ENFORCEMENT' ? (
                        <>
                            <Link href="/escalations" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                                <AlertOctagon className="w-3.5 h-3.5" />
                                Escalations
                            </Link>
                            <Link href="/intelligence" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                                <Shield className="w-3.5 h-3.5" />
                                Intelligence
                            </Link>
                            <Link href="/cctv" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                                <Camera className="w-3.5 h-3.5" />
                                CCTV
                            </Link>
                            <Link href="/cctv/criminals" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                                <Database className="w-3.5 h-3.5" />
                                Criminal DB
                            </Link>
                            <Link href="/community" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                                <ThumbsUp className="w-3.5 h-3.5" />
                                Community votes
                            </Link>
                            <Link href="/profile" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                                <Settings className="w-3.5 h-3.5" />
                                Profile
                            </Link>
                        </>
                    ) : role === 'MODERATOR' ? (
                        <>
                            <Link href="/moderation" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                                <Siren className="w-3.5 h-3.5" />
                                Moderation
                            </Link>
                            <Link href="/resolutions" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                                <CheckCircle className="w-3.5 h-3.5" />
                                Resolutions
                            </Link>
                            <Link href="/community" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                                <ThumbsUp className="w-3.5 h-3.5" />
                                Community votes
                            </Link>
                            <Link href="/profile" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                                <Settings className="w-3.5 h-3.5" />
                                Profile
                            </Link>
                        </>
                    ) : (
                        <>
                    {canUseCitizenRouteTools && (
                        <Link href="/route" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                            <Route className="w-3.5 h-3.5" />
                            Safe Route
                        </Link>
                    )}
                    {canUseCitizenRouteTools && (
                        <Link href="/report" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                            <FileWarning className="w-3.5 h-3.5" />
                            Submit Report
                        </Link>
                    )}
                    <Link href="/community" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                        <ThumbsUp className="w-3.5 h-3.5" />
                        Community votes
                    </Link>
                    {user && (
                        <Link href="/profile" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                            <Settings className="w-3.5 h-3.5" />
                            Profile
                        </Link>
                    )}
                    {user && (user.role === 'MODERATOR' || user.role === 'ADMIN') && (
                        <Link href="/moderation" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                            <Siren className="w-3.5 h-3.5" />
                            Moderation
                        </Link>
                    )}
                    {user && (user.role === 'LAW_ENFORCEMENT' || user.role === 'ADMIN') && (
                        <Link href="/intelligence" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                            <Shield className="w-3.5 h-3.5" />
                            Intelligence
                        </Link>
                    )}
                    {user && (user.role === 'ADMIN' || user.role === 'LAW_ENFORCEMENT') && (
                        <Link href="/escalations" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                            <AlertOctagon className="w-3.5 h-3.5" />
                            Escalations
                        </Link>
                    )}
                    {user && (user.role === 'ADMIN' || user.role === 'MODERATOR') && (
                        <Link href="/resolutions" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                            <CheckCircle className="w-3.5 h-3.5" />
                            Resolutions
                        </Link>
                    )}
                    {user && (user.role === 'MODERATOR' || user.role === 'LAW_ENFORCEMENT' || user.role === 'ADMIN') && (
                        <>
                            {user.role === 'ADMIN' && (
                            <Link href="/cctv" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                                <Camera className="w-3.5 h-3.5" />
                                CCTV
                            </Link>
                            )}
                            {(user.role === 'LAW_ENFORCEMENT' || user.role === 'ADMIN') && (
                                <Link href="/cctv/criminals" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                                    <Database className="w-3.5 h-3.5" />
                                    Criminal DB
                                </Link>
                            )}
                            {user.role === 'ADMIN' && (
                                <Link href="/suspect-review" className="text-sm md:text-xs lg:text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 px-3 md:px-2 lg:px-2.5 py-2 md:py-1.5 rounded-lg transition-all flex items-center gap-1.5 whitespace-nowrap">
                                    <UserSearch className="w-3.5 h-3.5" />
                                    Suspects
                                </Link>
                            )}
                        </>
                    )}
                        </>
                    )}
                </div>

                {/* Right: Auth state */}
                <div className="flex items-center gap-1.5 lg:gap-2 shrink-0">
                    {loading ? (
                        <div className="w-8 h-8 rounded-full bg-slate-800 animate-pulse" />
                    ) : user ? (
                        <>
                            {/* Notifications */}
                            <div className="relative">
                                <button
                                    onClick={() => setShowNotifs(!showNotifs)}
                                    className="p-2 text-slate-400 hover:text-white transition-colors relative"
                                    title="Notifications"
                                >
                                    <Bell className="w-5 h-5" />
                                    {unreadCount > 0 && (
                                        <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-rose-500 rounded-full animate-pulse" />
                                    )}
                                </button>
                                
                                {showNotifs && (
                                    <div className="absolute right-0 mt-2 w-80 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl py-2 z-[2100] overflow-hidden">
                                        <div className="px-4 py-2 border-b border-slate-800 flex justify-between items-center">
                                            <span className="font-semibold text-sm">Notifications</span>
                                            <div className="flex items-center gap-2">
                                                {unreadCount > 0 && <span className="text-xs text-rose-400 bg-rose-500/10 px-2 rounded-full">{unreadCount} New</span>}
                                                {notifications.length > 0 && (
                                                    <button
                                                        onClick={clearNotifications}
                                                        className="text-xs text-slate-400 hover:text-rose-400 transition-colors"
                                                        title="Clear all notifications"
                                                    >
                                                        Clear all
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                        <div className="max-h-80 overflow-y-auto">
                                            {notifications.length === 0 ? (
                                                <div className="px-4 py-6 text-center text-sm text-slate-500">No recent activity</div>
                                            ) : (
                                                notifications.map(n => (
                                                    <div
                                                        key={n.id} 
                                                        className={`px-4 py-3 border-b border-slate-800/50 transition-colors ${!n.isRead ? 'bg-slate-800/50 hover:bg-slate-800' : 'hover:bg-slate-800/30'}`}
                                                    >
                                                        <div className="flex items-start justify-between gap-3">
                                                            <div
                                                                className="cursor-pointer flex-1 min-w-0"
                                                                onClick={() => {
                                                                    if (!n.isRead) void markAsRead(n.id);
                                                                }}
                                                            >
                                                                {n.type === 'WITNESS_PROMPT' && n.reportId ? (
                                                                    <Link
                                                                        href={`/witness/${n.reportId}`}
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            if (!n.isRead) void markAsRead(n.id);
                                                                        }}
                                                                        className={`text-sm block hover:underline ${!n.isRead ? 'text-slate-200' : 'text-slate-400'}`}
                                                                    >
                                                                        {n.message}
                                                                        <span className="block text-xs text-indigo-400 mt-1 font-semibold">Open witness check-in →</span>
                                                                    </Link>
                                                                ) : (
                                                                    <p className={`text-sm ${!n.isRead ? 'text-slate-200' : 'text-slate-400'}`}>{n.message}</p>
                                                                )}
                                                                <p className="text-xs text-slate-500 mt-1">{new Date(n.createdAt).toLocaleDateString()} {new Date(n.createdAt).toLocaleTimeString()}</p>
                                                            </div>
                                                            <button
                                                                onClick={() => deleteNotification(n.id)}
                                                                className="text-slate-500 hover:text-rose-400 transition-colors mt-0.5"
                                                                title="Delete notification"
                                                            >
                                                                <Trash2 className="w-3.5 h-3.5" />
                                                            </button>
                                                        </div>
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Role badge */}
                            <span className={`hidden xl:inline-flex text-xs font-semibold px-2 py-0.5 rounded-full border ${roleBadge[user.role]?.className}`}>
                                {roleBadge[user.role]?.label}
                            </span>
                            {/* Avatar + email */}
                            <div className="hidden lg:flex items-center gap-1.5 bg-slate-800 border border-slate-700 rounded-xl px-2 py-1">
                                <div className="w-6 h-6 rounded-full bg-indigo-600 flex items-center justify-center">
                                    <UserIcon className="w-3.5 h-3.5 text-white" />
                                </div>
                                <span className="text-[11px] text-slate-300 font-medium max-w-[96px] truncate">
                                    {user.email || user.phone}
                                </span>
                            </div>
                            {/* Logout */}
                            <button
                                onClick={handleLogout}
                                className="text-slate-500 hover:text-rose-400 transition-colors p-1.5 hover:bg-slate-800 rounded-lg"
                                title="Sign out"
                            >
                                <LogOut className="w-4 h-4" />
                            </button>
                        </>
                    ) : (
                        <>
                            <Link href="/login" className="text-sm font-medium text-slate-400 hover:text-white transition-colors">
                                Sign In
                            </Link>
                            <Link
                                href="/report"
                                className="bg-rose-600 hover:bg-rose-500 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-all shadow-lg shadow-rose-600/20 active:scale-95"
                            >
                                Report Incident
                            </Link>
                        </>
                    )}
                </div>
            </div>
            </nav>
        </>
    );
}
