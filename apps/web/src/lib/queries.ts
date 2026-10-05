import { useQuery } from '@tanstack/react-query';
import type { Account, AppConfig, Label, Template, User } from '../types';
import { api } from './api';

/** Shared, cached queries used across features. */
export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Account[]>('/api/accounts') });
export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/api/users') });
export const useLabels = () => useQuery({ queryKey: ['labels'], queryFn: () => api.get<(Label & { usage: number })[]>('/api/labels') });
export const useTemplates = () => useQuery({ queryKey: ['templates'], queryFn: () => api.get<Template[]>('/api/templates') });
export const useAppConfig = () =>
  useQuery({ queryKey: ['config'], queryFn: () => api.get<AppConfig>('/api/config'), staleTime: Number.POSITIVE_INFINITY });
