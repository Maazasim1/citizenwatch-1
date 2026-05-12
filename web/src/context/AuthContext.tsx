'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { getApiBaseUrl } from '@/lib/apiBase';
import { registerUnauthorizedHandler } from '@/lib/authFetch';

interface User {
    id: string;
    email: string | null;
    phone: string | null;
    role: 'CITIZEN' | 'MODERATOR' | 'LAW_ENFORCEMENT' | 'ADMIN';
    fullName?: string | null;
    age?: number | null;
    sex?: 'MALE' | 'FEMALE' | 'UNDISCLOSED';
    avatarUrl?: string | null;
    notificationPrefs?: Record<string, boolean> | null;
    witnessNotificationsEnabled?: boolean;
    witnessAlertLatitude?: number | null;
    witnessAlertLongitude?: number | null;
}
type UserRole = 'CITIZEN' | 'MODERATOR' | 'LAW_ENFORCEMENT' | 'ADMIN';

interface AuthContextType {
    user: User | null;
    token: string | null;
    loading: boolean;
    login: (credentials: { email?: string; phone?: string; password: string }) => Promise<{ error?: string, requiresOtp?: boolean, userId?: string }>;
    register: (data: { email?: string; phone?: string; password: string; role?: UserRole }) => Promise<{ error?: string, requiresOtp?: boolean, userId?: string }>;
    verifyOtp: (data: { userId: string; otpCode: string }) => Promise<{ error?: string }>;
    logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    // Hydrate auth state from localStorage on mount
    useEffect(() => {
        const storedToken = localStorage.getItem('sc_token');
        const storedUser = localStorage.getItem('sc_user');
        if (storedToken && storedUser) {
            setToken(storedToken);
            setUser(JSON.parse(storedUser));
        }
        setLoading(false);
    }, []);

    const parseJsonSafe = async (res: Response) => {
        try {
            return await res.json();
        } catch {
            return null;
        }
    };

    const login = async (credentials: { email?: string; phone?: string; password: string }) => {
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(credentials),
            });
            const data = await parseJsonSafe(res);
            if (!res.ok) return { error: data?.error || `Login failed (${res.status})` };
            if (!data) return { error: 'Login failed: invalid server response' };
            
            if (data.requiresOtp) {
                return { requiresOtp: true, userId: data.userId };
            }

            localStorage.setItem('sc_token', data.token);
            localStorage.setItem('sc_user', JSON.stringify(data.user));
            setToken(data.token);
            setUser(data.user);
            return {};
        } catch {
            return { error: 'Network error. Please check if the API server is running.' };
        }
    };

    const register = async (credentials: { email?: string; phone?: string; password: string; role?: UserRole }) => {
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(credentials),
            });
            const data = await parseJsonSafe(res);
            if (!res.ok) return { error: data?.error || `Registration failed (${res.status})` };
            if (!data) return { error: 'Registration failed: invalid server response' };
            
            if (data.requiresOtp) {
                return { requiresOtp: true, userId: data.userId };
            }
            
            return login(credentials);
        } catch {
            return { error: 'Network error. Please check if the API server is running.' };
        }
    };

    const verifyOtp = async ({ userId, otpCode }: { userId: string, otpCode: string }) => {
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/auth/verify-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, otpCode }),
            });
            const data = await parseJsonSafe(res);
            if (!res.ok) return { error: data?.error || `Verification failed (${res.status})` };
            if (!data) return { error: 'Verification failed: invalid server response' };

            localStorage.setItem('sc_token', data.token);
            localStorage.setItem('sc_user', JSON.stringify(data.user));
            setToken(data.token);
            setUser(data.user);
            return {};
        } catch {
            return { error: 'Network error. Please check if the API server is running.' };
        }
    };

    const logout = useCallback(() => {
        localStorage.removeItem('sc_token');
        localStorage.removeItem('sc_user');
        setToken(null);
        setUser(null);
    }, []);

    useEffect(() => {
        registerUnauthorizedHandler(() => {
            logout();
            if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
                window.location.href = '/login';
            }
        });
        return () => registerUnauthorizedHandler(null);
    }, [logout]);

    return (
        <AuthContext.Provider value={{ user, token, loading, login, register, verifyOtp, logout }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
    return ctx;
}
