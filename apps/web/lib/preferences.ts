'use client';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
export const usePreferences = create<{ dark: boolean; toggle: () => void }>()(persist(set => ({ dark: false, toggle: () => set(state => ({ dark: !state.dark })) }), { name: 'smart-ui-preferences' }));
