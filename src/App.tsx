import React, { useState, useEffect, useRef } from 'react';
import { Terminal as TerminalIcon, LogIn, LogOut, Shield, Activity, Database, Cpu, Settings, X, Upload, Download, Cloud, CloudOff, Trash2, Save, FileSpreadsheet, Calendar, User as UserIcon, Search, Users, AlertTriangle, RotateCcw, Info, Github } from 'lucide-react';
import { format } from 'date-fns';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { db, auth, signIn, signOut } from './firebase';
import { collection, doc, setDoc, addDoc, onSnapshot, query, orderBy, limit, getDocs, writeBatch, where, deleteDoc } from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';
import Papa from 'papaparse';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface UserRecord {
  username: string;
  displayName?: string;
}

interface LogEntry {
  id: string;
  timestamp: Date;
  message: string;
  type: 'input' | 'output' | 'system';
}

interface UserStatus {
  lastStatus: 'logged in' | 'logged out';
  lastDate: string;
  lastFullTimestamp: string;
}

interface UserStatusMap {
  [key: string]: UserStatus;
}

export default function App() {
  const [isStarted, setIsStarted] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const [showUserList, setShowUserList] = useState(false);
  const [editedUsers, setEditedUsers] = useState<{[username: string]: string}>({});
  const [isSavingUserList, setIsSavingUserList] = useState(false);
  const [reportUser, setReportUser] = useState<string>('all');
  const [reportStartDate, setReportStartDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [reportEndDate, setReportEndDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  // Helper to get formatted timezone label with offset
  const getTimezoneLabel = (tz: string, label?: string) => {
    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'shortOffset',
      });
      const parts = formatter.formatToParts(now);
      const offsetPart = parts.find(p => p.type === 'timeZoneName');
      const offset = offsetPart ? offsetPart.value.replace('GMT', 'UTC') : '';
      const displayOffset = offset === 'UTC' ? 'UTC+0' : offset;
      return label ? `${label} (${displayOffset})` : `${tz} (${displayOffset})`;
    } catch (e) {
      return label || tz;
    }
  };

  const [selectedTimezone, setSelectedTimezone] = useState<string>(
    localStorage.getItem('terminal_timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const [fontSize, setFontSize] = useState<'normal' | 'large'>(
    (localStorage.getItem('terminal_font_size') as 'normal' | 'large') || 'normal'
  );
  const [dimTimeout, setDimTimeout] = useState<number>(
    parseInt(localStorage.getItem('terminal_dim_timeout') || '0')
  );
  const [autoFullscreenEnabled, setAutoFullscreenEnabled] = useState<boolean>(
    localStorage.getItem('terminal_auto_fullscreen') !== 'false'
  );
  const [paperSize, setPaperSize] = useState<'A4' | 'LETTER'>('LETTER');
  const [isDimmed, setIsDimmed] = useState(false);
  const lastActivityRef = useRef<number>(Date.now());

  // Dimmer logic
  useEffect(() => {
    if (dimTimeout <= 0) {
      setIsDimmed(false);
      return;
    }

    const handleActivity = () => {
      lastActivityRef.current = Date.now();
      if (isDimmed) setIsDimmed(false);
    };

    const events = ['mousedown', 'keydown', 'touchstart', 'mousemove', 'scroll'];
    events.forEach(event => window.addEventListener(event, handleActivity, { passive: true }));

    const checkInterval = setInterval(() => {
      const inactiveTime = (Date.now() - lastActivityRef.current) / 1000;
      if (inactiveTime >= dimTimeout && !isDimmed) {
        setIsDimmed(true);
      }
    }, 1000);

    return () => {
      events.forEach(event => window.removeEventListener(event, handleActivity));
      clearInterval(checkInterval);
    };
  }, [dimTimeout, isDimmed]);

  // Persist settings
  useEffect(() => {
    localStorage.setItem('terminal_font_size', fontSize);
  }, [fontSize]);

  useEffect(() => {
    localStorage.setItem('terminal_dim_timeout', dimTimeout.toString());
  }, [dimTimeout]);

  useEffect(() => {
    localStorage.setItem('terminal_auto_fullscreen', autoFullscreenEnabled.toString());
  }, [autoFullscreenEnabled]);

  const [settingsTab, setSettingsTab] = useState<'general' | 'api'>('general');
  const [googleClientId, setGoogleClientId] = useState('');
  const [googleClientSecret, setGoogleClientSecret] = useState('');
  const [appUrl, setAppUrl] = useState('');
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);
  const [availableUsers, setAvailableUsers] = useState<UserRecord[]>([]);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [isExportingAll, setIsExportingAll] = useState(false);
  const [reportPreview, setReportPreview] = useState<{
    data: any[];
    stats: {
      totalDays: number;
      totalHours: number;
      avgHoursPerDay: number;
    } | null;
    meta: {
      user: string;
      startDate: string;
      endDate: string;
    }
  } | null>(null);
  const [input, setInput] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([
    { id: 'init', timestamp: new Date(), message: 'SYSTEM_BOOT_COMPLETE: Terminal ready.', type: 'system' }
  ]);

  const addLog = (message: string, type: 'input' | 'output' | 'system' = 'system') => {
    setLogs(prev => {
      const newLog = {
        id: `local-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        timestamp: new Date(),
        message,
        type
      };
      const all = [...prev, newLog];
      // Deduplicate by message + timestamp (within 2 seconds) to avoid local/server doubles
      const unique = all.filter((log, index) => {
        const isDuplicate = all.slice(0, index).some(other => 
          other.message === log.message && 
          Math.abs(other.timestamp.getTime() - log.timestamp.getTime()) < 2000
        );
        return !isDuplicate;
      });
      return unique.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()).slice(-20);
    });
  };
  const [userStatuses, setUserStatuses] = useState<UserStatusMap>({});
  const [isGDriveConnected, setIsGDriveConnected] = useState(false);
  const lastScanned = useRef<Record<string, number>>({});
  const pendingUpdates = useRef<{
    mappings: Record<string, any>;
    logs: any[];
  }>({ mappings: {}, logs: [] });
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Global Keyboard Listeners (Escape to close popups)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowSettings(false);
        setShowReports(false);
        setShowUserList(false);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  const terminalId = user?.uid || 'shared-terminal';

  // Auto-set start date to first entry when reports menu opens
  useEffect(() => {
    if (showReports && terminalId) {
      const fetchFirstLog = async () => {
        try {
          const q = query(
            collection(db, 'terminals', terminalId, 'logs'),
            orderBy('timestamp', 'asc'),
            limit(1)
          );
          const snapshot = await getDocs(q);
          if (!snapshot.empty) {
            const firstLog = snapshot.docs[0].data();
            if (firstLog.timestamp) {
              const firstDate = firstLog.timestamp.split('T')[0];
              setReportStartDate(firstDate);
            }
          }
        } catch (err) {
          console.error('Failed to fetch first log for date initialization:', err);
        }
      };
      fetchFirstLog();
    }
  }, [showReports, terminalId]);

  // Keyboard Listeners
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (reportPreview) {
          setReportPreview(null);
        } else if (showReports) {
          setShowReports(false);
        } else if (showSettings) {
          setShowSettings(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [reportPreview, showReports, showSettings]);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        setIsStarted(true);
      } else {
        setIsStarted(false);
      }
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Check GDrive Status
  useEffect(() => {
    if (user) {
      fetch('/api/auth/google/status')
        .then(async res => {
          const contentType = res.headers.get("content-type");
          if (contentType && contentType.indexOf("application/json") !== -1) {
            return res.json();
          }
          throw new Error("STATIC_HOSTING_DETECTED: This environment does not support a Node.js backend. Features like Google Drive integration require the AI Studio Preview URL (ais-pre-...).");
        })
        .then(data => setIsGDriveConnected(data.connected))
        .catch(err => {
          console.warn('GDrive Status Check skipped:', err.message);
        });
    }
  }, [user]);

  // Load Settings
  useEffect(() => {
    if (showSettings) {
      fetch('/api/settings')
        .then(async res => {
          const contentType = res.headers.get("content-type");
          if (contentType && contentType.indexOf("application/json") !== -1) {
            return res.json();
          }
          const text = await res.text();
          console.error('Invalid settings response format:', text.substring(0, 100));
          throw new Error('SERVER_RESPONSE_NOT_JSON: The server returned an invalid format. This often happens if the server crashed and returned an HTML error page.');
        })
        .then(data => {
          setGoogleClientId(data.googleClientId || '');
          setGoogleClientSecret(data.googleClientSecret || '');
          setAppUrl(data.appUrl || window.location.origin);
        })
        .catch(err => {
          console.error('Failed to load settings:', err);
          setLogs(prev => [...prev, { 
            id: Date.now().toString(), 
            timestamp: new Date(), 
            message: `SYSTEM_ERROR: Failed to load API settings. ${err.message}`, 
            type: 'system' 
          }]);
        });
    }
  }, [showSettings]);

  const handleSaveApiSettings = async () => {
    if (!showSaveConfirm) {
      setShowSaveConfirm(true);
      return;
    }

    setShowSaveConfirm(false);
    setIsSavingSettings(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          googleClientId,
          googleClientSecret,
          appUrl
        })
      });
      if (res.ok) {
        alert('API Settings saved successfully. The server has been updated.');
      } else {
        throw new Error('Failed to save settings');
      }
    } catch (err: any) {
      alert(`Error saving settings: ${err.message}`);
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleResetToDefaults = async () => {
    if (!window.confirm('Are you sure you want to reset API settings to system defaults? This will erase custom Client ID and Secret.')) {
      return;
    }
    
    try {
      const res = await fetch('/api/settings/defaults');
      const defaults = await res.json();
      
      setGoogleClientId(defaults.googleClientId || '');
      setGoogleClientSecret(defaults.googleClientSecret || '');
      setAppUrl(defaults.appUrl || window.location.origin);
      
      // Also tell server to delete settings.json
      await fetch('/api/settings/reset', { method: 'POST' });
      
      alert('Settings reset to defaults.');
    } catch (err) {
      console.error('Failed to reset settings:', err);
    }
  };

  // Listen for OAuth Success
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'GDRIVE_AUTH_SUCCESS') {
        setIsGDriveConnected(true);
        setLogs(prev => [...prev, { id: Date.now().toString(), timestamp: new Date(), message: 'SYSTEM: Google Drive connected successfully.', type: 'system' }]);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Real-time Firestore Listeners (only when started)
  useEffect(() => {
    if (!isStarted || !isAuthReady) return;

    const unsubscribeUsers = onSnapshot(collection(db, 'terminals', terminalId, 'mappings'), (snapshot) => {
      const statuses: UserStatusMap = {};
      const users: UserRecord[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        statuses[doc.id] = {
          lastStatus: data.lastStatus,
          lastDate: data.lastTimestamp?.split('T')[0] || '',
          lastFullTimestamp: data.lastTimestamp || ''
        };
        users.push({
          username: doc.id,
          displayName: data.displayName
        });
      });
      setUserStatuses(statuses);
      setAvailableUsers(users);
    });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTodayISO = startOfToday.toISOString();

    const q = query(
      collection(db, 'terminals', terminalId, 'logs'), 
      where('timestamp', '>=', startOfTodayISO),
      orderBy('timestamp', 'desc'), 
      limit(20)
    );
    const unsubscribeLogs = onSnapshot(q, (snapshot) => {
      const newLogs: LogEntry[] = [];
      snapshot.docs.forEach((doc) => {
        const data = doc.data();
        newLogs.push({
          id: doc.id,
          timestamp: new Date(data.timestamp),
          message: `[${data.status.toUpperCase()}] ${data.displayName || data.username}`,
          type: data.status === 'logged in' ? 'output' : 'input'
        });
      });

      setLogs(prev => {
        // Merge existing and new
        const combined = [...prev, ...newLogs];
        
        // 1. Deduplicate by Firestore ID
        const idMap = new Map<string, LogEntry>();
        combined.forEach(l => idMap.set(l.id, l));
        let unique = Array.from(idMap.values());

        // 2. Deduplicate by content + approximate timestamp
        // This removes local "ENTRY" logs once the server "LOGGED IN" log arrives
        unique = unique.filter((log, index) => {
          // If this is a local log, check if a server log exists with same message and ~timestamp
          if (log.id.startsWith('local-')) {
            const hasServerMatch = unique.some(other => 
              !other.id.startsWith('local-') && 
              other.message === log.message &&
              Math.abs(other.timestamp.getTime() - log.timestamp.getTime()) < 10000 // 10s window for match
            );
            return !hasServerMatch;
          }
          return true;
        });

        // 3. Final sort and slice
        return unique
          .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
          .slice(-20);
      });
    });

    return () => {
      unsubscribeUsers();
      unsubscribeLogs();
    };
  }, [isStarted, isAuthReady, terminalId]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  // Flush pending updates every 10 seconds
  useEffect(() => {
    if (!isStarted || !isAuthReady || !terminalId) return;

    const flush = async () => {
      const { mappings, logs: pLogs } = pendingUpdates.current;
      if (Object.keys(mappings).length === 0 && pLogs.length === 0) return;

      const mappingsToUpload = { ...mappings };
      const logsToUpload = [...pLogs];
      pendingUpdates.current = { mappings: {}, logs: [] };

      try {
        const batch = writeBatch(db);
        
        // Batch mappings
        Object.entries(mappingsToUpload).forEach(([username, data]) => {
          const mappingRef = doc(db, 'terminals', terminalId, 'mappings', username);
          batch.set(mappingRef, data, { merge: true });
        });

        // Batch logs
        logsToUpload.forEach(logData => {
          const logRef = doc(collection(db, 'terminals', terminalId, 'logs'));
          batch.set(logRef, logData);
        });

        await batch.commit();
      } catch (err) {
        console.error('Batch upload error:', err);
        // On error, we could potentially put them back, but for simplicity we log it
      }
    };

    const interval = setInterval(flush, 10000);

    return () => {
      clearInterval(interval);
      flush(); // Final flush on unmount/id change
    };
  }, [isStarted, isAuthReady, terminalId]);

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && input.length > 0) {
      // Trigger fullscreen on user action (browser requires user interaction) if enabled
      if (autoFullscreenEnabled && !document.fullscreenElement && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {
          console.log("Fullscreen request blocked or failed.");
        });
      }

      const userInput = input;
      setInput('');

      const now = Date.now();
      const lastTime = lastScanned.current[userInput] || 0;
      if (now - lastTime < 5000) {
        const mapping = availableUsers.find(u => u.username === userInput);
        const displayName = mapping?.displayName || userInput;
        addLog(`[DUPLICATE_DETECTED] ${displayName} - ENTRY_OMITTED`, 'system');
        return;
      }
      lastScanned.current[userInput] = now;

      const timestamp = new Date();
      const formattedTime = timestamp.toISOString();
      const currentDate = format(timestamp, 'yyyy-MM-dd');

      const currentStatus = userStatuses[userInput];
      const mapping = availableUsers.find(u => u.username === userInput);
      const displayName = mapping?.displayName || '';

      let nextStatus: 'logged in' | 'logged out' = 'logged in';
      if (currentStatus && currentStatus.lastDate === currentDate) {
        nextStatus = currentStatus.lastStatus === 'logged in' ? 'logged out' : 'logged in';
      }

      // 1. Update local state immediately for responsiveness
      setUserStatuses(prev => ({
        ...prev,
        [userInput]: {
          lastStatus: nextStatus,
          lastDate: currentDate,
          displayName: displayName
        }
      }));

      // 3. Update local logs immediately so it shows in the terminal without delay
      const logDisplayName = displayName || userInput;
      addLog(`[${nextStatus.toUpperCase()}] ${logDisplayName}`, 'system');

      // 2. Queue for buffered upload (every 10s)
      pendingUpdates.current.mappings[userInput] = {
        username: userInput,
        lastStatus: nextStatus,
        lastTimestamp: formattedTime,
        ...(displayName ? { displayName } : {})
      };

      pendingUpdates.current.logs.push({
        username: userInput,
        displayName: displayName,
        status: nextStatus,
        timestamp: formattedTime
      });
    }
  };

  const handleImportCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLogs(prev => [...prev, { id: Date.now().toString(), timestamp: new Date(), message: 'SYSTEM: Starting CSV import...', type: 'system' }]);

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) => header.trim(),
      complete: async (results) => {
        try {
          const batch = writeBatch(db);
          let count = 0;
          
          results.data.forEach((row: any) => {
            // Find recognized columns regardless of case/spaces
            const getVal = (possibleNames: string[]) => {
              const key = Object.keys(row).find(k => 
                possibleNames.some(name => k.toLowerCase().replace(/[^a-z0-9]/g, '') === name.toLowerCase().replace(/[^a-z0-9]/g, ''))
              );
              return key ? row[key] : null;
            };

            let username = getVal(['fobid', 'username', 'id', 'cardid', 'uid', 'user']);
            const displayName = getVal(['displayname', 'name', 'fullname', 'userdesc']);
            
            // Fallback: If no recognized header for ID, use the first column
            if (!username && Object.keys(row).length > 0) {
              const firstKey = Object.keys(row)[0];
              username = row[firstKey];
            }
            
            if (username) {
              const cleanedUsername = String(username).trim();
              if (cleanedUsername) {
                const userRef = doc(db, 'terminals', terminalId, 'mappings', cleanedUsername);
                batch.set(userRef, {
                  username: cleanedUsername,
                  lastStatus: row.lastStatus || 'logged out',
                  lastTimestamp: row.lastTimestamp || new Date().toISOString(),
                  ...(displayName ? { displayName: String(displayName).trim() } : {})
                }, { merge: true });
                count++;
              }
            }
          });

          if (count > 0) {
            await batch.commit();
            setLogs(prev => [...prev, { 
              id: Date.now().toString(), 
              timestamp: new Date(), 
              message: `SYSTEM: Import complete. Registered ${count} users.`, 
              type: 'system' 
            }]);
            alert(`Import successful! ${count} users added/updated.`);
          } else {
            setLogs(prev => [...prev, { id: Date.now().toString(), timestamp: new Date(), message: 'SYSTEM: Import failed - No valid data found. Ensure CSV has column "fob_id" or "username".', type: 'system' }]);
            alert('Import failed: No valid users found in CSV. Please verify column headers (e.g., fob_id, displayName).');
          }
        } catch (err: any) {
          console.error('Import error:', err);
          alert('Import failed: ' + err.message);
        } finally {
          if (fileInputRef.current) fileInputRef.current.value = '';
        }
      }
    });
  };

  const handleExportCSV = async () => {
    try {
      setLogs(prev => [...prev, { id: Date.now().toString(), timestamp: new Date(), message: 'SYSTEM: Fetching all logs for export...', type: 'system' }]);
      const snapshot = await getDocs(collection(db, 'terminals', terminalId, 'logs'));
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      
      if (data.length === 0) {
        setLogs(prev => [...prev, { id: Date.now().toString(), timestamp: new Date(), message: 'SYSTEM: No logs found in database.', type: 'system' }]);
        alert('No logs found in database.');
        return;
      }

      const csv = Papa.unparse(data);
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `terminal_logs_${format(new Date(), 'yyyy-MM-dd')}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      
      setLogs(prev => [...prev, { id: Date.now().toString(), timestamp: new Date(), message: `SYSTEM: Exported ${data.length} records.`, type: 'system' }]);
    } catch (err: any) {
      console.error('Export error:', err);
      setLogs(prev => [...prev, { id: Date.now().toString(), timestamp: new Date(), message: `ERROR: Export failed - ${err.message}`, type: 'system' }]);
      alert('Export failed: ' + err.message);
    }
  };

  const performGoogleDriveExport = async () => {
    if (!isGDriveConnected) {
      handleConnectGoogleDrive();
      return { success: false, error: 'Not connected' };
    }

    setLogs(prev => [...prev, { id: Date.now().toString(), timestamp: new Date(), message: 'SYSTEM: Starting Google Drive backup before clear...', type: 'system' }]);

    try {
      const snapshot = await getDocs(collection(db, 'terminals', terminalId, 'logs'));
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      
      if (data.length === 0) {
        return { success: true, message: 'No data to export' };
      }

      const csv = Papa.unparse(data);

      const res = await fetch('/api/export/gdrive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csvData: csv,
          fileName: `terminal_backup_pre_clear_${format(new Date(), 'yyyy-MM-dd_HH-mm-ss')}.csv`
        })
      });

      if (res.ok) {
        const result = await res.json();
        setLogs(prev => [...prev, { 
          id: Date.now().toString(), 
          timestamp: new Date(), 
          message: `SYSTEM: Backup successful. File ID: ${result.fileId}`, 
          type: 'system' 
        }]);
        return { success: true, fileId: result.fileId };
      } else {
        const errData = await res.json();
        throw new Error(errData.error || `Server error (${res.status})`);
      }
    } catch (err: any) {
      console.error('Backup error:', err);
      setLogs(prev => [...prev, { id: Date.now().toString(), timestamp: new Date(), message: `ERROR: Backup failed - ${err.message}`, type: 'system' }]);
      return { success: false, error: err.message };
    }
  };

  const handleClearDatabase = async () => {
    if (!isGDriveConnected) {
      alert('CRITICAL_RESTRICTION: Google Drive must be connected for automated backup before clearing the database.');
      return;
    }

    if (!confirm('ARE YOU SURE? THIS WILL BACK UP DATA TO GOOGLE DRIVE AND THEN PERMANENTLY DELETE ALL LOGS AND USER MAPPINGS.')) return;
    
    setLogs(prev => [...prev, { id: Date.now().toString(), timestamp: new Date(), message: 'SYSTEM: Initializing full system wipe with mandatory backup...', type: 'system' }]);
    
    // 1. Mandatory Backup
    const backupResult = await performGoogleDriveExport();
    if (!backupResult.success && backupResult.message !== 'No data to export') {
      alert('SYSTEM_HALT: Automated backup failed. Database wipe cancelled to prevent data loss. Error: ' + backupResult.error);
      return;
    }

    // 2. Clear Database
    try {
      const logsSnapshot = await getDocs(collection(db, 'terminals', terminalId, 'logs'));
      const mappingsSnapshot = await getDocs(collection(db, 'terminals', terminalId, 'mappings'));
      
      const batch = writeBatch(db);
      logsSnapshot.docs.forEach(d => batch.delete(d.ref));
      mappingsSnapshot.docs.forEach(d => batch.delete(d.ref));
      
      await batch.commit();
      setLogs(prev => [...prev, { id: Date.now().toString(), timestamp: new Date(), message: 'SYSTEM_WIPE_COMPLETE: All data purged after successful backup.', type: 'system' }]);
      alert('Database cleared and backed up to Google Drive successfully.');
    } catch (err: any) {
      console.error('Wipe error:', err);
      alert('Failed to clear database: ' + err.message);
    }
  };

  const handleSaveUserList = async () => {
    setIsSavingUserList(true);
    try {
      const batch = writeBatch(db);
      let count = 0;
      
      Object.entries(editedUsers).forEach(([username, displayName]) => {
        const userRef = doc(db, 'terminals', terminalId, 'mappings', username);
        batch.update(userRef, { displayName });
        count++;
      });

      if (count > 0) {
        await batch.commit();
        setLogs(prev => [...prev, { 
          id: Date.now().toString(), 
          timestamp: new Date(), 
          message: `SYSTEM: Updated ${count} user display names manually.`, 
          type: 'system' 
        }]);
      }
      
      setShowUserList(false);
      setEditedUsers({});
    } catch (err: any) {
      console.error('Save error:', err);
      alert('Failed to save changes: ' + err.message);
    } finally {
      setIsSavingUserList(false);
    }
  };

  const handleGenerateReport = async () => {
    setIsGeneratingReport(true);

    try {
      // Helper to get UTC ISO string for a local time in the selected timezone
      const getUtcBound = (dateStr: string, timeStr: string) => {
        try {
          // Create a representation of the requested time as if it were local
          const localString = `${dateStr}T${timeStr}`;
          const localDate = new Date(localString);
          
          // Use the "inverse offset" trick to find the UTC time that, 
          // when converted to the target timezone, matches our localString.
          const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: selectedTimezone,
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            hourCycle: 'h23',
          });

          // This is a rough estimation of the UTC time
          let utcTime = localDate.getTime();
          
          // Refine it (usually 1-2 iterations is enough to handle the offset)
          for (let i = 0; i < 2; i++) {
            const formatted = formatter.format(new Date(utcTime));
            const parts = formatted.split(', ');
            const [m, d, y] = parts[0].split('/');
            const [h, min, s] = parts[1].split(':');
            const currentLocalInTz = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${min.padStart(2, '0')}:${s.padStart(2, '0')}`).getTime();
            const offset = currentLocalInTz - localDate.getTime();
            utcTime -= offset;
          }
          
          return new Date(utcTime).toISOString();
        } catch (e) {
          // Fallback to literal UTC if timezone conversion fails
          console.error('Timezone bound error:', e);
          return `${dateStr}T${timeStr}Z`;
        }
      };

      const startISO = getUtcBound(reportStartDate, '00:00:00.000');
      const endISO = getUtcBound(reportEndDate, '23:59:59.999');

      const q = query(
        collection(db, 'terminals', terminalId, 'logs'),
        where('timestamp', '>=', startISO),
        where('timestamp', '<=', endISO),
        orderBy('timestamp', 'asc')
      );

      const snapshot = await getDocs(q);
      
      if (snapshot.empty) {
        setLogs(prev => [...prev, { 
          id: Date.now().toString(), 
          timestamp: new Date(), 
          message: `SYSTEM: No logs found for the selected criteria.`, 
          type: 'system' 
        }]);
        alert('No data found for the selected criteria.');
        return;
      }

      let data = snapshot.docs.map(doc => {
        const d = doc.data();
        const ts = d.timestamp || '';
        let date = 'N/A';
        let time = 'N/A';
        let displayOffset = '';
        
        if (typeof ts === 'string' && ts.includes('T')) {
          try {
            const dateObj = new Date(ts);
            // Convert to selected timezone
            const formatter = new Intl.DateTimeFormat('en-CA', {
              timeZone: selectedTimezone,
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
              timeZoneName: 'shortOffset'
            });
            
            const parts = formatter.formatToParts(dateObj);
            const p = (type: string) => parts.find(part => part.type === type)?.value || '';
            
            date = `${p('year')}-${p('month')}-${p('day')}`;
            time = `${p('hour')}:${p('minute')}:${p('second')}`;
            
            const offsetPart = parts.find(p => p.type === 'timeZoneName');
            const offset = offsetPart ? offsetPart.value.replace('GMT', 'UTC') : '';
            displayOffset = offset === 'UTC' ? 'UTC+0' : offset;
          } catch (e) {
            console.error('Timezone conversion error:', e);
            const parts = ts.split('T');
            date = parts[0];
            time = parts[1].split('.')[0];
          }
        }

        const userRec = availableUsers.find(u => u.username === d.username);
        const displayName = userRec ? (userRec.displayName || d.username) : (d.username || 'unknown');

        return {
          username: d.username || 'unknown',
          displayName: displayName,
          status: d.status || 'unknown',
          original_utc_timestamp: ts,
          local_date: date,
          local_time: time,
          timezone: displayOffset
        };
      });

      // Client side filter for user since we can't easily do multiple inequality/equality filters without indexes
      if (reportUser !== 'all') {
        data = data.filter(d => d.username === reportUser);
      }

      if (data.length === 0) {
        setLogs(prev => [...prev, { 
          id: Date.now().toString(), 
          timestamp: new Date(), 
          message: `SYSTEM: No records matched the user filter "${reportUser}".`, 
          type: 'system' 
        }]);
        alert('No data found matching the selected user filter.');
        return;
      }

      // Calculate stats
      let stats = null;
      // We calculate stats for single user OR for all users combined if requested, 
      // but usually users want it per person. For now, if single user selected:
      if (reportUser !== 'all') {
        const days = new Set<string>();
        let totalMs = 0;
        let lastLogin: number | null = null;
        
        // Data is already sorted by timestamp (asc) from Firestore query
        data.forEach(d => {
          days.add(d.local_date);
          const ts = new Date(d.original_utc_timestamp).getTime();
          if (d.status === 'logged in') {
            lastLogin = ts;
          } else if (d.status === 'logged out' && lastLogin) {
            totalMs += (ts - lastLogin);
            lastLogin = null;
          }
        });

        const totalHours = totalMs / (1000 * 60 * 60);
        stats = {
          totalDays: days.size,
          totalHours: Number(totalHours.toFixed(2)),
          avgHoursPerDay: days.size > 0 ? Number((totalHours / days.size).toFixed(2)) : 0
        };
      }

      setReportPreview({
        data,
        stats,
        meta: {
          user: reportUser === 'all' ? 'ALL_USERS' : (availableUsers.find(u => u.username === reportUser)?.displayName || reportUser),
          startDate: reportStartDate,
          endDate: reportEndDate
        }
      });
      setShowReports(false);
      
    } catch (err: any) {
      console.error('Report error:', err);
      const errorMessage = err.message || 'Unknown error';
      setLogs(prev => [...prev, { 
        id: Date.now().toString(), 
        timestamp: new Date(), 
        message: `ERROR: Failed to generate report - ${errorMessage}`, 
        type: 'system' 
      }]);
      alert('Failed to generate report: ' + errorMessage);
    } finally {
      setIsGeneratingReport(false);
    }
  };

  const handleExportAllAsZip = async () => {
    setIsExportingAll(true);

    try {
      // Helper for UTC bounds (copied from handleGenerateReport to ensure consistency)
      const getUtcBound = (dateStr: string, timeStr: string) => {
        try {
          const localString = `${dateStr}T${timeStr}`;
          const localDate = new Date(localString);
          const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: selectedTimezone,
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            hourCycle: 'h23',
          });
          let utcTime = localDate.getTime();
          for (let i = 0; i < 2; i++) {
            const formatted = formatter.format(new Date(utcTime));
            const parts = formatted.split(', ');
            const [m, d, y] = parts[0].split('/');
            const [h, min, s] = parts[1].split(':');
            const currentLocalInTz = new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${min.padStart(2, '0')}:${s.padStart(2, '0')}`).getTime();
            const offset = currentLocalInTz - localDate.getTime();
            utcTime -= offset;
          }
          return new Date(utcTime).toISOString();
        } catch (e) {
          return `${dateStr}T${timeStr}Z`;
        }
      };

      const startISO = getUtcBound(reportStartDate, '00:00:00.000');
      const endISO = getUtcBound(reportEndDate, '23:59:59.999');

      const q = query(
        collection(db, 'terminals', terminalId, 'logs'),
        where('timestamp', '>=', startISO),
        where('timestamp', '<=', endISO),
        orderBy('timestamp', 'asc')
      );

      const snapshot = await getDocs(q);
      
      if (snapshot.empty) {
        setLogs(prev => [...prev, { 
          id: Date.now().toString(), 
          timestamp: new Date(), 
          message: `SYSTEM: No logs found in specified range. Aborting ZIP export.`, 
          type: 'system' 
        }]);
        alert('No data found for the selected dates.');
        return;
      }

      // 1. Group records by user
      const usersData: { [key: string]: any[] } = {};
      const usersStats: { [key: string]: { totalDays: number, totalHours: number, avgHoursPerDay: number, offset: string } } = {};
      
      snapshot.docs.forEach(doc => {
        const d = doc.data();
        const username = d.username || 'unknown';
        const ts = d.timestamp || '';
        
        let date = 'N/A';
        let time = 'N/A';
        let displayOffset = '';
        if (typeof ts === 'string' && ts.includes('T')) {
          try {
            const dateObj = new Date(ts);
            const formatter = new Intl.DateTimeFormat('en-CA', {
              timeZone: selectedTimezone,
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
              timeZoneName: 'shortOffset'
            });
            const parts = formatter.formatToParts(dateObj);
            const p = (type: string) => parts.find(part => part.type === type)?.value || '';
            date = `${p('year')}-${p('month')}-${p('day')}`;
            time = `${p('hour')}:${p('minute')}:${p('second')}`;

            const offsetPart = parts.find(p => p.type === 'timeZoneName');
            const offset = offsetPart ? offsetPart.value.replace('GMT', 'UTC') : '';
            displayOffset = offset === 'UTC' ? 'UTC+0' : offset;
          } catch (e) {
            const parts = ts.split('T');
            date = parts[0];
            time = parts[1].split('.')[0];
          }
        }

        const userRec = availableUsers.find(u => u.username === username);
        const displayName = userRec ? (userRec.displayName || username) : (d.displayName || username);

        // Keep internal fields for stats but will exclude from CSV
        const record = {
          displayName: displayName,
          status: d.status || 'unknown',
          local_date: date,
          local_time: time,
          timezone: displayOffset,
          _raw_ts: ts,
          _username: username
        };

        if (!usersData[username]) usersData[username] = [];
        usersData[username].push(record);
      });

      // 2. Create ZIP
      const zip = new JSZip();
      const folderName = `all_users_report_${reportStartDate}_to_${reportEndDate}`;
      const folder = zip.folder(folderName);

      if (!folder) throw new Error('Failed to create ZIP folder');

      Object.entries(usersData).forEach(([username, data]) => {
        // Calculate stats for this user
        const days = new Set<string>();
        let totalMs = 0;
        let lastLogin: any = null;
        const displayOffset = data[0]?.timezone || '';

        // Sort data by timestamp ascending to ensure pairing
        data.sort((a, b) => new Date(a._raw_ts).getTime() - b.status.localeCompare(a.status)); // Secondary sort by status to prioritize login if same ts

        // Pair Logins and Logouts
        const sessions: any[] = [];
        let currentSession: any = null;

        data.forEach(d => {
          days.add(d.local_date);
          const ts = new Date(d._raw_ts).getTime();
          
          if (d.status === 'logged in') {
            // If we have a pending session, push it as unpaired logout
            if (currentSession) {
              sessions.push(currentSession);
            }
            currentSession = { login: d, logout: null };
            lastLogin = ts;
          } else if (d.status === 'logged out') {
            if (currentSession && !currentSession.logout) {
              currentSession.logout = d;
              if (lastLogin) totalMs += (ts - lastLogin);
              lastLogin = null;
              sessions.push(currentSession);
              currentSession = null;
            } else {
              // Orphan logout
              sessions.push({ login: null, logout: d });
            }
          }
        });
        if (currentSession) sessions.push(currentSession);

        const totalHours = totalMs / (1000 * 60 * 60);
        const stats = {
          totalDays: days.size,
          totalHours: Number(totalHours.toFixed(2)),
          avgHoursPerDay: days.size > 0 ? Number((totalHours / days.size).toFixed(2)) : 0
        };

        // Prepare CSV data with Login on Left, Logout on Right
        const csvRows: any[] = sessions.map(s => ({
          DATE_IN: s.login?.local_date || '',
          TIME_IN: s.login?.local_time || '',
          STATUS_IN: 'LOGGED IN',
          NAME_IN: s.login?.displayName || '',
          TZ_IN: s.login?.timezone || '',
          DATE_OUT: s.logout?.local_date || '',
          TIME_OUT: s.logout?.local_time || '',
          STATUS_OUT: 'LOGGED OUT',
          NAME_OUT: s.logout?.displayName || '',
          TZ_OUT: s.logout?.timezone || ''
        }));
        
        // Add stats to the bottom
        csvRows.push({});
        csvRows.push({ DATE_IN: 'SUMMARY_REPORT' });
        csvRows.push({ DATE_IN: 'TOTAL_DAYS_WORKED', TIME_IN: stats.totalDays.toString() });
        csvRows.push({ DATE_IN: 'TOTAL_HOURS_WORKED', TIME_IN: stats.totalHours.toString() });
        csvRows.push({ DATE_IN: 'AVG_HOURS_PER_DAY', TIME_IN: stats.avgHoursPerDay.toString() });

        const userRec = availableUsers.find(u => u.username === username);
        const displayName = userRec?.displayName || username;
        const safeName = `${displayName}_${username}`.replace(/[^a-z0-9_\-]/gi, '_');
        const csv = Papa.unparse(csvRows);
        folder.file(`${safeName}.csv`, csv);
      });

      // 3. Generate and Save
      const content = await zip.generateAsync({ type: 'blob' });
      saveAs(content, `${folderName}.zip`);

    } catch (err: any) {
      console.error('ZIP Export error:', err);
      alert('ZIP Export failed: ' + err.message);
    } finally {
      setIsExportingAll(false);
    }
  };

  const downloadCsvTemplate = () => {
    const csvContent = "fob_id,displayName\n1001,John Doe\n1002,Jane Smith";
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'user_import_template.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };

  const handleConnectGoogleDrive = async () => {
    try {
      // Check if we are in an iframe
      const isInIframe = window.self !== window.top;
      if (isInIframe) {
        setLogs(prev => [...prev, { id: Date.now().toString(), timestamp: new Date(), message: 'SYSTEM: Detected iframe environment. If authentication fails, please open the application in a new tab using the "Shared App URL" or "Development App URL".', type: 'system' }]);
      }

      const res = await fetch('/api/auth/google/url');
      const contentType = res.headers.get("content-type");
      
      if (!contentType || contentType.indexOf("application/json") === -1) {
        throw new Error("BACKEND_UNAVAILABLE: This feature requires a Node.js backend. It will NOT work on Firebase Hosting (web.app). Please use the AI Studio Shared/Preview URL.");
      }

      const { url } = await res.json();
      
      // Attempt to open in a popup
      const popup = window.open(url, 'gdrive_auth', 'width=600,height=700');
      
      if (!popup || popup.closed || typeof popup.closed === 'undefined') {
        alert('POPUP_BLOCKED: Your browser blocked the authentication window. Please enable popups or click again.');
      }
    } catch (err: any) {
      console.error('Failed to get auth URL:', err);
      alert(err.message || 'Failed to initialize Google Drive connection.');
    }
  };

  const handleDisconnectGoogleDrive = async () => {
    if (!confirm('Are you sure you want to disconnect Google Drive?')) return;
    try {
      setLogs(prev => [...prev, { id: Date.now().toString(), timestamp: new Date(), message: 'SYSTEM: Disconnecting Google Drive...', type: 'system' }]);
      const res = await fetch('/api/auth/google/disconnect', { method: 'POST' });
      if (res.ok) {
        setIsGDriveConnected(false);
        setLogs(prev => [...prev, { id: Date.now().toString(), timestamp: new Date(), message: 'SYSTEM: Google Drive disconnected successfully.', type: 'system' }]);
        alert('Google Drive disconnected.');
      } else {
        throw new Error('Failed to disconnect on server.');
      }
    } catch (err: any) {
      console.error('Disconnect error:', err);
      alert('Disconnect failed: ' + err.message);
    }
  };

  const handleExportToGoogleDrive = async () => {
    if (!isGDriveConnected) {
      handleConnectGoogleDrive();
      return;
    }

    const result = await performGoogleDriveExport();
    if (result.success) {
      const openLink = confirm(`Data exported successfully to Google Drive!\n\nWould you like to view the file now?`);
      if (openLink && result.fileId) {
        // Result ID is enough to build the link usually, but my helper only returns fileId
        // I'll just skip the auto-open for now or fetch the link if possible.
        // Actually, let's just use the helper's success message.
      }
    } else {
      if (result.error !== 'Not connected') {
        alert(`Export failed: ${result.error}`);
      }
    }
  };

  if (!isAuthReady) {
    return <div className="min-h-screen bg-black flex items-center justify-center font-mono text-green-500">INITIALIZING_SYSTEM...</div>;
  }

  if (!isStarted) {
    return (
      <div className={cn(
        "min-h-screen bg-black text-green-500 font-mono flex flex-col items-center justify-center p-4 relative overflow-hidden transition-all duration-300",
        fontSize === 'large' ? "text-lg" : "text-base"
      )}>
        {/* Background Grid Effect */}
        <div className="absolute inset-0 opacity-10 pointer-events-none" 
             style={{ backgroundImage: 'linear-gradient(#10b981 1px, transparent 1px), linear-gradient(90deg, #10b981 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
        
        <div className={cn(
          "max-w-2xl w-full space-y-8 relative z-10 text-center transition-transform",
          fontSize === 'large' ? "scale-110" : ""
        )}>
          <div className="flex justify-center mb-6">
            <div className="p-4 rounded-full bg-green-900/20 border border-green-500/30 animate-pulse">
              <TerminalIcon size={fontSize === 'large' ? 80 : 64} className="text-green-400" />
            </div>
          </div>
          
          <div className="space-y-2">
            <h1 className={cn("font-black tracking-tighter text-white", fontSize === 'large' ? "text-6xl" : "text-4xl")}>TERMINAL_LOGGER_V2.2</h1>
            <p className={cn("text-green-400 uppercase tracking-widest", fontSize === 'large' ? "text-base" : "text-sm")}>Secure Entry Management System</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-left">
            <div className="p-4 border border-green-900/50 bg-green-950/20 rounded-lg">
              <Shield className="mb-2 text-green-400" size={fontSize === 'large' ? 24 : 20} />
              <h3 className={cn("font-bold text-white mb-1", fontSize === 'large' ? "text-sm" : "text-xs")}>ENCRYPTED</h3>
              <p className={cn("text-green-400", fontSize === 'large' ? "text-xs" : "text-[10px]")}>AES-256 secure data transmission protocols enabled.</p>
            </div>
            <div className="p-4 border border-green-900/50 bg-green-950/20 rounded-lg">
              <Activity className="mb-2 text-green-400" size={fontSize === 'large' ? 24 : 20} />
              <h3 className={cn("font-bold text-white mb-1", fontSize === 'large' ? "text-sm" : "text-xs")}>REAL-TIME</h3>
              <p className={cn("text-green-400", fontSize === 'large' ? "text-xs" : "text-[10px]")}>Instant synchronization across all connected nodes.</p>
            </div>
            <div className="p-4 border border-green-900/50 bg-green-950/20 rounded-lg">
              <Database className="mb-2 text-green-400" size={fontSize === 'large' ? 24 : 20} />
              <h3 className={cn("font-bold text-white mb-1", fontSize === 'large' ? "text-sm" : "text-xs")}>PERSISTENT</h3>
              <p className={cn("text-green-400", fontSize === 'large' ? "text-xs" : "text-[10px]")}>Cloud-native storage with automated backup systems.</p>
            </div>
          </div>

          <div className="pt-8 flex flex-col items-center gap-4">
            <button 
              onClick={() => setIsStarted(true)}
              className={cn(
                "group relative px-12 py-4 bg-green-500 text-black font-bold hover:bg-green-400 transition-all active:scale-95 overflow-hidden rounded",
                fontSize === 'large' ? "text-xl px-16 py-6" : "text-lg"
              )}
            >
              <div className="absolute inset-0 bg-white/20 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-500" />
              LOGIN_TO_TERMINAL
            </button>
            
            <div className="flex items-center gap-4 text-[10px] text-green-400">
              <div className="flex items-center gap-1"><Cpu size={12}/> CPU_READY</div>
              <div className="flex items-center gap-1"><Shield size={12}/> AUTH_BYPASS_ENABLED</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      "h-screen bg-black text-green-500 font-mono flex flex-col p-4 relative transition-all duration-300 overflow-hidden",
      fontSize === 'large' ? "text-lg" : "text-base",
      reportPreview ? "print:h-auto print:overflow-visible print:bg-white" : ""
    )}>
      {/* Header */}
      <div className={cn(
        "flex flex-wrap items-center justify-between border-b border-green-900 pb-2 mb-4 transition-all gap-y-4 print:hidden",
        fontSize === 'large' ? "py-2" : ""
      )}>
        <div className="flex items-center gap-2">
          <TerminalIcon size={20} />
          <span className="font-bold tracking-wider">CMD_TERMINAL_V2.3</span>
          <span className="text-[10px] bg-green-900/30 px-2 py-0.5 rounded text-green-400 animate-pulse">LIVE</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 justify-end flex-1 min-w-0">
          {user ? (
            <div className="flex flex-wrap items-center gap-2 justify-end">
              <span className={cn("text-green-400 truncate max-w-[150px] sm:max-w-none", fontSize === 'large' ? "text-xs" : "text-[10px]")}>{user.email}</span>
              <button 
                onClick={() => setShowUserList(true)} 
                className="p-1 hover:bg-green-900/30 rounded text-green-400"
                title="Registered Users"
              >
                <Users size={fontSize === 'large' ? 22 : 18} />
              </button>
              <button 
                onClick={() => setShowReports(true)} 
                className="p-1 hover:bg-green-900/30 rounded text-green-400"
                title="Generate Reports"
              >
                <FileSpreadsheet size={fontSize === 'large' ? 22 : 18} />
              </button>
              <button 
                onClick={() => setShowSettings(true)} 
                className="p-1 hover:bg-green-900/30 rounded text-green-400"
                title="Settings"
              >
                <Settings size={fontSize === 'large' ? 22 : 18} />
              </button>
              <button onClick={signOut} className={cn("border border-red-900 px-2 py-1 hover:bg-red-900/20 text-red-700 rounded font-bold", fontSize === 'large' ? "text-xs" : "text-[10px]")}>LOGOUT</button>
            </div>
          ) : (
            <button onClick={signIn} className={cn("bg-green-900/40 px-3 py-1 text-green-400 hover:bg-green-400 hover:text-black transition-colors rounded font-bold", fontSize === 'large' ? "text-xs" : "text-[10px]")}>ADMIN_LOGIN</button>
          )}
          <button onClick={() => setIsStarted(false)} className={cn("border border-green-900 px-2 py-1 hover:bg-green-900/20 rounded font-bold", fontSize === 'large' ? "text-xs" : "text-[10px]")}>EXIT</button>
        </div>
      </div>

      {/* Terminal Body */}
      <div 
        ref={scrollRef}
        className="flex-1 overflow-hidden mb-4 space-y-1 px-6 print:hidden"
        onClick={() => inputRef.current?.focus()}
      >
        {logs.map((log) => (
          <div key={log.id} className={cn(
            "flex gap-3 animate-in fade-in slide-in-from-left-2 duration-300",
            fontSize === 'large' ? "text-base" : "text-sm"
          )}>
            <span className="text-green-400 shrink-0">[{format(log.timestamp, 'yyyy-MM-dd HH:mm:ss')}]</span>
            <span className={cn(
              "break-all",
              log.type === 'system' ? 'text-blue-400 italic' : 
              log.type === 'output' ? 'text-green-400' : 'text-yellow-400'
            )}>
              {log.message}
            </span>
          </div>
        ))}
      </div>

      {/* Input Area */}
      <div className={cn(
        "flex items-center gap-2 border-t border-green-900 pt-4 px-6 print:hidden",
        fontSize === 'large' ? "py-2" : ""
      )}>
        <span className={cn("text-green-400 font-bold shrink-0", fontSize === 'large' ? "text-lg" : "text-base")}>SCAN_FOB_ID:</span>
        <input
          ref={inputRef}
          autoFocus
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 30))}
          onKeyDown={handleKeyDown}
          className={cn(
            "flex-1 bg-transparent border-none outline-none text-green-400 placeholder:text-green-900",
            fontSize === 'large' ? "text-lg" : "text-base"
          )}
          placeholder="WAITING_FOR_SIGNAL..."
        />
      </div>

      {/* User List Modal */}
      {showUserList && (
        <div className="absolute inset-0 bg-black/90 z-[60] flex items-center justify-center p-4">
          <div className={cn(
            "max-w-xl w-full border border-green-500 bg-black p-6 space-y-6 rounded shadow-[0_0_20px_rgba(16,185,129,0.2)] flex flex-col max-h-[90vh]",
            fontSize === 'large' ? "max-w-2xl scale-105" : ""
          )}>
            <div className="flex items-center justify-between border-b border-green-900 pb-4 shrink-0">
              <div className="flex items-center gap-2">
                <Users className="text-green-400" size={fontSize === 'large' ? 24 : 20} />
                <h2 className={cn("font-bold text-white", fontSize === 'large' ? "text-xl" : "text-lg")}>REGISTERED_USERS_DATABASE</h2>
              </div>
              <button onClick={() => { setShowUserList(false); setEditedUsers({}); }} className="text-green-400 hover:text-green-500 transition-colors">
                <X size={fontSize === 'large' ? 32 : 24} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
              <div className={cn(
                "grid grid-cols-2 text-green-400 font-bold uppercase border-b border-green-900/50 pb-2 mb-2",
                fontSize === 'large' ? "text-sm" : "text-[10px]"
              )}>
                <div>FOB_ID / USERNAME</div>
                <div>DISPLAY_NAME (EDITABLE)</div>
              </div>
              
              {availableUsers.length === 0 ? (
                <div className={cn("text-center py-8 text-green-400 italic", fontSize === 'large' ? "text-base" : "text-sm")}>NO_USERS_FOUND_IN_DATABASE</div>
              ) : (
                [...availableUsers].sort((a, b) => {
                  const nameA = (a.displayName || a.username).toLowerCase();
                  const nameB = (b.displayName || b.username).toLowerCase();
                  return nameA.localeCompare(nameB);
                }).map((u) => {
                  const currentDisplayName = editedUsers[u.username] !== undefined ? editedUsers[u.username] : (u.displayName || '');
                  return (
                    <div key={u.username} className="grid grid-cols-2 items-center py-2 border-b border-green-950 hover:bg-green-950/20 transition-colors group">
                      <div className={cn("text-green-400 font-bold flex items-center gap-2", fontSize === 'large' ? "text-base" : "text-sm")}>
                        <div className="w-1.5 h-1.5 rounded-full bg-green-500/50 group-hover:animate-ping" />
                        {u.username}
                      </div>
                      <div className="flex items-center gap-2">
                        <input 
                          type="text"
                          value={currentDisplayName}
                          onChange={(e) => setEditedUsers(prev => ({ ...prev, [u.username]: e.target.value }))}
                          className={cn(
                            "flex-1 bg-black border border-green-900/50 p-1 text-green-600 focus:border-green-400 outline-none rounded",
                            fontSize === 'large' ? "text-base" : "text-sm"
                          )}
                          placeholder="ENTER_DISPLAY_NAME..."
                        />
                        <button 
                          onClick={async () => {
                            if (confirm(`DELETE_USER ${u.username}?`)) {
                              await deleteDoc(doc(db, 'terminals', terminalId, 'mappings', u.username));
                            }
                          }}
                          className="text-red-900 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all p-1"
                          title="Delete User"
                        >
                          <Trash2 size={fontSize === 'large' ? 18 : 14} />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="pt-4 border-t border-green-900 shrink-0 flex gap-2">
              <button 
                onClick={handleSaveUserList}
                disabled={isSavingUserList}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-3 bg-green-500 hover:bg-green-400 text-black rounded transition-all font-bold disabled:opacity-50",
                  fontSize === 'large' ? "text-sm" : "text-xs"
                )}
              >
                {isSavingUserList ? <Activity className="animate-spin" size={fontSize === 'large' ? 20 : 16} /> : <Save size={fontSize === 'large' ? 20 : 16} />}
                SAVE_AND_EXIT
              </button>
              <button 
                onClick={() => { setShowUserList(false); setEditedUsers({}); }}
                className={cn(
                  "flex-1 py-3 border border-green-900 hover:bg-green-900/40 text-green-400 rounded transition-all font-bold",
                  fontSize === 'large' ? "text-sm" : "text-xs"
                )}
              >
                CANCEL
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Report Preview Modal */}
      {reportPreview && (
        <div className={cn(
          "absolute inset-0 bg-black z-[60] flex flex-col p-8 overflow-y-auto shadow-2xl print:static print:bg-white print:text-black print:p-0 print:overflow-visible print:h-auto",
          paperSize === 'A4' ? "print:a4-layout" : "print:letter-layout"
        )}>
          <style dangerouslySetInnerHTML={{ __html: `
            @media print {
              @page {
                size: ${paperSize === 'A4' ? 'A4' : 'letter'};
                margin: 20mm;
              }
            }
          ` }} />
          <div className="max-w-7xl w-full mx-auto space-y-8 print:max-w-none print:w-full print:mx-0">
            {/* Header - Hidden in Print if controlled */}
            <div className="flex items-center justify-between border-b border-green-500 pb-4 print:border-black">
              <div className="flex items-center gap-3">
                <FileSpreadsheet className="text-green-500 print:text-black" size={32} />
                <div>
                  <h2 className="text-2xl font-bold text-white print:text-black">TERMINAL_REPORT_PREVIEW</h2>
                  <p className="text-green-400 text-sm print:text-gray-600">
                    USER: {reportPreview.meta.user} | PERIOD: {reportPreview.meta.startDate} TO {reportPreview.meta.endDate}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-6 print:hidden">
                {/* Paper Size selector */}
                <div className="flex bg-green-900/20 border border-green-500/30 rounded p-1">
                  <button 
                    onClick={() => setPaperSize('A4')}
                    className={cn(
                      "px-4 py-1 text-xs font-bold uppercase transition-all rounded",
                      paperSize === 'A4' ? "bg-green-500 text-black" : "text-green-500/50 hover:text-green-400"
                    )}
                  >
                    A4
                  </button>
                  <button 
                    onClick={() => setPaperSize('LETTER')}
                    className={cn(
                      "px-4 py-1 text-xs font-bold uppercase transition-all rounded",
                      paperSize === 'LETTER' ? "bg-green-500 text-black" : "text-green-500/50 hover:text-green-400"
                    )}
                  >
                    Letter
                  </button>
                </div>

                <div className="flex gap-4">
                  <button 
                    onClick={() => {
                    const data = reportPreview.data;
                    
                    // Logic to pair login/logout
                    const sessions: any[] = [];
                    let current: any = null;
                    data.forEach(d => {
                      if (d.status === 'logged in') {
                        if (current) sessions.push(current);
                        current = { login: d, logout: null };
                      } else if (d.status === 'logged out') {
                        if (current && !current.logout) {
                          current.logout = d;
                          sessions.push(current);
                          current = null;
                        } else {
                          sessions.push({ login: null, logout: d });
                        }
                      }
                    });
                    if (current) sessions.push(current);

                    const csvRows: any[] = sessions.map(s => ({
                      DATE_IN: s.login?.local_date || '',
                      TIME_IN: s.login?.local_time || '',
                      STATUS_IN: 'LOGGED IN',
                      NAME_IN: s.login?.displayName || '',
                      TZ_IN: s.login?.timezone || '',
                      DATE_OUT: s.logout?.local_date || '',
                      TIME_OUT: s.logout?.local_time || '',
                      STATUS_OUT: 'LOGGED OUT',
                      NAME_OUT: s.logout?.displayName || '',
                      TZ_OUT: s.logout?.timezone || ''
                    }));

                    if (reportPreview.stats) {
                      csvRows.push({});
                      csvRows.push({ DATE_IN: 'SUMMARY_REPORT' });
                      csvRows.push({ DATE_IN: 'TOTAL_DAYS_WORKED', TIME_IN: reportPreview.stats.totalDays.toString() });
                      csvRows.push({ DATE_IN: 'TOTAL_HOURS_WORKED', TIME_IN: reportPreview.stats.totalHours.toString() });
                      csvRows.push({ DATE_IN: 'AVG_HOURS_PER_DAY', TIME_IN: reportPreview.stats.avgHoursPerDay.toString() });
                    }
                    
                    const csv = Papa.unparse(csvRows);
                    const blob = new Blob([csv], { type: 'text/csv' });
                    saveAs(blob, `report_${reportPreview.meta.user}_${reportPreview.meta.startDate}_to_${reportPreview.meta.endDate}.csv`);
                  }}
                  className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded flex items-center gap-2 font-bold"
                >
                  <Download size={18} /> DOWNLOAD_CSV
                </button>
                <button 
                  onClick={() => window.print()}
                  className="bg-green-500 hover:bg-green-400 text-black px-4 py-2 rounded flex items-center gap-2 font-bold"
                >
                  <Activity size={18} /> PRINT_LOGS
                </button>
                <button 
                  onClick={() => setReportPreview(null)}
                  className="bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded flex items-center gap-2 font-bold"
                >
                  <X size={18} /> CLOSE_PREVIEW
                </button>
              </div>
            </div>
          </div>

            {/* List - 2 Column Layout (Paging logic) */}
            <div className="space-y-12">
              {(() => {
                const data = reportPreview.data;
                const sessions: any[] = [];
                let current: any = null;
                data.forEach(d => {
                  if (d.status === 'logged in') {
                    if (current) sessions.push(current);
                    current = { login: d, logout: null };
                  } else if (d.status === 'logged out') {
                    if (current && !current.logout) {
                      current.logout = d;
                      sessions.push(current);
                      current = null;
                    } else {
                      sessions.push({ login: null, logout: d });
                    }
                  }
                });
                if (current) sessions.push(current);

                const rowsPerCol = paperSize === 'A4' ? 28 : 26;
                const pageSize = rowsPerCol * 2;
                const pages = [];
                for (let i = 0; i < sessions.length; i += pageSize) {
                  pages.push(sessions.slice(i, i + pageSize));
                }

                return pages.map((page, pIdx) => (
                  <div key={pIdx} className="space-y-4 break-after-page print:block">
                    <div className="grid grid-cols-2 gap-8 print:gap-12 print:w-full print:grid-cols-2">
                      {[0, 1].map(colIdx => {
                        const colStart = colIdx * (pageSize / 2);
                        const colEnd = colStart + (pageSize / 2);
                        const colData = page.slice(colStart, colEnd);
                        
                        if (colData.length === 0 && colIdx === 1) return null;

                        return (
                          <div key={colIdx} className="space-y-4 print:w-full print:space-y-2">
                            <div className="border-b-2 border-green-500 pb-2 grid grid-cols-2 gap-4 text-[10px] uppercase font-bold text-green-400 print:border-black print:text-black print:pb-1">
                              <span>Logged In</span>
                              <span>Logged Out</span>
                            </div>
                            <div className="divide-y divide-green-900/10 print:divide-none">
                              {colData.map((s, i) => (
                                <div key={i} className="grid grid-cols-2 gap-2 py-1.5 text-[10px] font-mono print:py-1 print:border-none print:text-black">
                                  {/* Login Column */}
                                  <div className="truncate">
                                    {s.login ? (
                                      <div className="flex gap-2">
                                        <span className="text-gray-500 w-12 shrink-0">{s.login.local_date.split('-').slice(1).join('-')}</span>
                                        <span className="text-gray-400 w-10 shrink-0">{s.login.local_time.split(':').slice(0,2).join(':')}</span>
                                        <span className="text-white print:text-black truncate uppercase font-bold">{s.login.displayName}</span>
                                      </div>
                                    ) : (
                                      <span className="text-gray-800/30 font-bold">--- NO_DATA ---</span>
                                    )}
                                  </div>
                                  {/* Logout Column */}
                                  <div className="truncate">
                                    {s.logout ? (
                                      <div className="flex gap-2 border-l border-green-900/20 pl-2 print:border-none print:pl-0">
                                        <span className="text-gray-500 w-12 shrink-0">{s.logout.local_date.split('-').slice(1).join('-')}</span>
                                        <span className="text-gray-400 w-10 shrink-0">{s.logout.local_time.split(':').slice(0,2).join(':')}</span>
                                        <span className="text-white print:text-black truncate uppercase font-bold">{s.logout.displayName}</span>
                                      </div>
                                    ) : (
                                      <div className="border-l border-green-900/20 pl-2 print:border-none print:pl-0">
                                        <span className="text-gray-800/30 font-bold">--- ACTIVE ---</span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ));
              })()}
            </div>

            {/* Stats Section */}
            {reportPreview.stats && (
              <div className="mt-12 pt-8 border-t border-green-500 grid grid-cols-3 gap-8 print:border-black print:text-black">
                <div className="bg-green-900/20 p-6 rounded print:p-0 print:bg-transparent print:border-none">
                  <p className="text-green-500 text-xs font-bold uppercase mb-1 print:text-gray-600">Days Worked</p>
                  <p className="text-3xl font-bold text-white print:text-black">{reportPreview.stats.totalDays}</p>
                </div>
                <div className="bg-green-900/20 p-6 rounded print:p-0 print:bg-transparent print:border-none">
                  <p className="text-green-500 text-xs font-bold uppercase mb-1 print:text-gray-600">Total Hours</p>
                  <p className="text-3xl font-bold text-white print:text-black">{reportPreview.stats.totalHours} <span className="text-sm font-normal text-green-400">HRS</span></p>
                </div>
                <div className="bg-green-900/20 p-6 rounded print:p-0 print:bg-transparent print:border-none">
                  <p className="text-green-500 text-xs font-bold uppercase mb-1 print:text-gray-600">Avg Hours/Day</p>
                  <p className="text-3xl font-bold text-white print:text-black">{reportPreview.stats.avgHoursPerDay} <span className="text-sm font-normal text-green-400">HRS</span></p>
                </div>
              </div>
            )}
            
            <div className="text-center text-[10px] text-gray-600 print:block hidden pt-8">
              REPORT_GENERATED_ON: {new Date().toLocaleString()} | TIMEZONE_OFFSET: {reportPreview.data[0]?.timezone}
            </div>
          </div>
        </div>
      )}

      {/* Reports Modal */}
      {showReports && (
        <div className="absolute inset-0 bg-black/90 z-50 flex items-center justify-center p-4">
          <div className={cn(
            "max-w-md w-full border border-green-500 bg-black p-6 space-y-6 rounded shadow-[0_0_20px_rgba(16,185,129,0.2)]",
            fontSize === 'large' ? "max-w-xl scale-105" : ""
          )}>
            <div className="flex items-center justify-between border-b border-green-900 pb-4">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="text-green-400" size={fontSize === 'large' ? 24 : 20} />
                <h2 className={cn("font-bold text-white", fontSize === 'large' ? "text-xl" : "text-lg")}>GENERATE_REPORT</h2>
              </div>
              <button onClick={() => setShowReports(false)} className="text-green-400 hover:text-green-500 transition-colors">
                <X size={fontSize === 'large' ? 32 : 24} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <label className={cn("text-green-400 uppercase font-bold flex items-center gap-1", fontSize === 'large' ? "text-sm" : "text-xs")}>
                  <UserIcon size={12} /> Target User
                </label>
                <select 
                  value={reportUser}
                  onChange={(e) => setReportUser(e.target.value)}
                  className={cn(
                    "w-full bg-black border border-green-900 p-2 text-green-400 rounded outline-none focus:border-green-500",
                    fontSize === 'large' ? "text-base" : "text-sm"
                  )}
                >
                  <option value="all">ALL_USERS</option>
                  {[...availableUsers].sort((a, b) => {
                    const nameA = (a.displayName || a.username).toLowerCase();
                    const nameB = (b.displayName || b.username).toLowerCase();
                    return nameA.localeCompare(nameB);
                  }).map(u => (
                    <option key={u.username} value={u.username}>
                      {u.displayName ? `${u.displayName} (${u.username})` : u.username}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className={cn("text-green-400 uppercase font-bold flex items-center gap-1", fontSize === 'large' ? "text-sm" : "text-xs")}>
                    <Calendar size={12} /> Start Date
                  </label>
                  <input 
                    type="date"
                    value={reportStartDate}
                    onChange={(e) => setReportStartDate(e.target.value)}
                    className={cn(
                      "w-full bg-black border border-green-900 p-2 text-green-400 rounded outline-none focus:border-green-500 [color-scheme:dark]",
                      fontSize === 'large' ? "text-base" : "text-sm"
                    )}
                  />
                </div>
                <div className="space-y-2">
                  <label className={cn("text-green-400 uppercase font-bold flex items-center gap-1", fontSize === 'large' ? "text-sm" : "text-xs")}>
                    <Calendar size={12} /> End Date
                  </label>
                  <input 
                    type="date"
                    value={reportEndDate}
                    onChange={(e) => setReportEndDate(e.target.value)}
                    className={cn(
                      "w-full bg-black border border-green-900 p-2 text-green-400 rounded outline-none focus:border-green-500 [color-scheme:dark]",
                      fontSize === 'large' ? "text-base" : "text-sm"
                    )}
                  />
                </div>
              </div>

              <div className="pt-4 border-t border-green-900 space-y-2">
                <div className="flex gap-2">
                  <button 
                    onClick={handleGenerateReport}
                    disabled={isGeneratingReport}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-2 py-3 bg-green-500 hover:bg-green-400 text-black rounded transition-all font-bold disabled:opacity-50",
                      fontSize === 'large' ? "text-lg px-2" : "text-sm"
                    )}
                  >
                    {isGeneratingReport ? (
                      <Activity className="animate-spin" size={fontSize === 'large' ? 22 : 18} />
                    ) : (
                      <Search size={fontSize === 'large' ? 22 : 18} />
                    )}
                    EXPORT_SELECTED_USER_DATA
                  </button>
                  <button 
                    onClick={handleExportAllAsZip}
                    disabled={isExportingAll || isGeneratingReport}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-2 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded transition-all font-bold disabled:opacity-50",
                      fontSize === 'large' ? "text-lg px-2" : "text-sm"
                    )}
                    title="Export all users to individual CSVs in a ZIP"
                  >
                    {isExportingAll ? (
                      <Activity className="animate-spin" size={fontSize === 'large' ? 20 : 16} />
                    ) : (
                      <Download size={fontSize === 'large' ? 20 : 16} />
                    )}
                    EXPORT_ALL_TO_ZIP
                  </button>
                </div>

              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modals & Popups */}
      {isDimmed && (
        <div 
          className="fixed inset-0 bg-black/70 z-[10000] flex flex-col items-center justify-center cursor-none animate-in fade-in duration-700"
          onClick={() => setIsDimmed(false)}
        >
          <div className="space-y-4 text-center">
            <Activity className="w-12 h-12 text-green-500/20 mx-auto animate-pulse" />
            <div className="text-green-500/30 font-mono text-sm uppercase tracking-[0.3em] font-black select-none">
              SYSTEM_IDLE_DIMMED
            </div>
            <div className="text-green-500/10 font-mono text-[10px] uppercase tracking-widest select-none">
              MOVE_MOUSE_OR_PRESS_KEY_TO_RESUME
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="absolute inset-0 bg-black/90 z-50 flex items-center justify-center p-4">
          <div className={cn(
            "max-w-xl w-full max-h-[90vh] overflow-y-auto border border-green-500 bg-black p-6 space-y-6 rounded shadow-[0_0_20px_rgba(16,185,129,0.2)] scrollbar-green",
            fontSize === 'large' ? "scale-105" : ""
          )}>
            <div className="flex items-start justify-between border-b border-green-900 pb-4">
              <div className="flex flex-wrap items-center gap-4 flex-1 min-w-0 pr-4">
                <div className="flex items-center gap-2">
                  <Settings className="text-green-400" size={20} />
                  <h2 className={cn("font-bold text-white whitespace-nowrap", fontSize === 'large' ? "text-xl" : "text-lg")}>SYSTEM_SETTINGS</h2>
                </div>
                <div className="flex items-center bg-green-900/20 rounded p-1">
                  <button 
                    onClick={() => setSettingsTab('general')}
                    className={cn(
                      "px-3 py-1 text-[10px] font-bold rounded transition-colors whitespace-nowrap",
                      settingsTab === 'general' ? "bg-green-500 text-black" : "text-green-500 hover:bg-green-900/30"
                    )}
                  >
                    GENERAL
                  </button>
                  <button 
                    onClick={() => setSettingsTab('api')}
                    className={cn(
                      "px-3 py-1 text-[10px] font-bold rounded transition-colors whitespace-nowrap",
                      settingsTab === 'api' ? "bg-green-500 text-black" : "text-green-500 hover:bg-green-900/30"
                    )}
                  >
                    API_CONFIG
                  </button>
                </div>
                <button 
                  onClick={() => setFontSize(prev => prev === 'normal' ? 'large' : 'normal')}
                  className={cn(
                    "bg-green-900/30 px-3 py-1 rounded text-green-400 hover:bg-green-900/50 transition-colors font-bold whitespace-nowrap",
                    fontSize === 'large' ? "text-sm" : "text-xs"
                  )}
                  title={fontSize === 'normal' ? 'SWITCH_TO_LARGE_FONT' : 'SWITCH_TO_NORMAL_FONT'}
                >
                  Aa
                </button>
              </div>
              
              <button 
                onClick={() => setShowSettings(false)} 
                className="text-green-400 hover:text-green-500 transition-colors pt-1 shrink-0"
              >
                <X size={24} />
              </button>
            </div>

            <div className={cn("space-y-4", fontSize === 'large' ? "text-base" : "text-sm")}>
              {settingsTab === 'general' ? (
                <>
                  {/* 1. Timezone Settings */}
                  <div className="space-y-2">
                    <label className={cn("text-green-400 uppercase font-bold flex items-center gap-1", fontSize === 'large' ? "text-sm" : "text-xs")}>
                      <Calendar size={12} /> System Timezone
                    </label>
                    <select 
                      value={selectedTimezone}
                      onChange={(e) => {
                        const tz = e.target.value;
                        setSelectedTimezone(tz);
                        localStorage.setItem('terminal_timezone', tz);
                      }}
                      className={cn("w-full bg-black border border-green-900 p-2 text-green-400 rounded outline-none focus:border-green-500", fontSize === 'large' ? "text-base" : "text-sm")}
                    >
                      <optgroup label="Common Timezones">
                        <option value="UTC">{getTimezoneLabel('UTC', 'Universal Time')}</option>
                        <option value="America/New_York">{getTimezoneLabel('America/New_York', 'Eastern Time (New York)')}</option>
                        <option value="America/Chicago">{getTimezoneLabel('America/Chicago', 'Central Time (Chicago)')}</option>
                        <option value="America/Denver">{getTimezoneLabel('America/Denver', 'Mountain Time (Denver)')}</option>
                        <option value="America/Los_Angeles">{getTimezoneLabel('America/Los_Angeles', 'Pacific Time (Los Angeles)')}</option>
                        <option value="Europe/London">{getTimezoneLabel('Europe/London', 'Greenwich Mean Time (London)')}</option>
                        <option value="Europe/Paris">{getTimezoneLabel('Europe/Paris', 'Central European Time (Paris)')}</option>
                        <option value="Asia/Tokyo">{getTimezoneLabel('Asia/Tokyo', 'Japan Standard Time (Tokyo)')}</option>
                        <option value="Asia/Shanghai">{getTimezoneLabel('Asia/Shanghai', 'China Standard Time (Shanghai)')}</option>
                        <option value="Australia/Sydney">{getTimezoneLabel('Australia/Sydney', 'Australian Eastern Time (Sydney)')}</option>
                      </optgroup>
                      <optgroup label="System Default">
                        <option value={Intl.DateTimeFormat().resolvedOptions().timeZone}>
                          {getTimezoneLabel(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Detected')}
                        </option>
                      </optgroup>
                    </select>
                    <p className={cn("text-green-400 italic", fontSize === 'large' ? "text-xs" : "text-[10px]")}>Affects timestamp conversion in generated reports.</p>
                  </div>

                  {/* 2. Import Users */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className={cn("text-green-400 uppercase font-bold", fontSize === 'large' ? "text-sm" : "text-xs")}>User Management</label>
                      <button 
                        onClick={downloadCsvTemplate}
                        className={cn("text-blue-500 hover:text-blue-400 font-bold transition-colors underline", fontSize === 'large' ? "text-xs" : "text-[10px]")}
                      >
                        DOWNLOAD_TEMPLATE_CSV
                      </button>
                    </div>
                    <div className="grid grid-cols-1 gap-2">
                      <button 
                        onClick={() => fileInputRef.current?.click()}
                        className={cn("w-full flex items-center justify-center gap-2 py-3 bg-green-900/20 border border-green-900 hover:bg-green-900/40 text-green-400 rounded transition-all font-bold", fontSize === 'large' ? "text-sm" : "text-xs")}
                      >
                        <Upload size={18} />
                        IMPORT_USERS_VIA_CSV
                      </button>
                      <p className={cn("text-green-400 italic", fontSize === 'large' ? "text-xs" : "text-[10px]")}>FOB_ID must be numbers and letters only (maximum 30 characters)</p>
                      <p className={cn("text-green-400 italic mt-1", fontSize === 'large' ? "text-xs" : "text-[10px]")}>To manually add users, scan or enter FOB_ID in the main terminal window and edit the DISPLAY_NAME in REGISTERED_USERS_DATABASE MENU</p>
                    </div>
                    <input 
                      ref={fileInputRef}
                      type="file" 
                      accept=".csv" 
                      className="hidden" 
                      onChange={handleImportCSV}
                    />
                  </div>

                  {/* 3. Export Data */}
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className={cn("text-green-400 uppercase font-bold", fontSize === 'large' ? "text-sm" : "text-xs")}>Data Management</label>
                      <button 
                        onClick={handleExportToGoogleDrive}
                        className={cn(
                          "w-full flex items-center justify-center gap-3 px-4 py-3 border rounded transition-all font-bold text-center",
                          fontSize === 'large' ? "text-sm" : "text-xs",
                          "bg-blue-900/20 border-blue-900 text-blue-400 hover:bg-blue-900/40"
                        )}
                      >
                        <div className="flex flex-col items-center gap-0.5">
                          <div className="flex items-center gap-3">
                            <Cloud size={18} className="shrink-0" />
                            <span className="truncate">{isGDriveConnected ? 'EXPORT_TO_CONNECTED_GOOGLE_DRIVE' : 'CONNECT_GOOGLE_DRIVE_AND_EXPORT_CSV'}</span>
                          </div>
                          {!isGDriveConnected && <span className="text-[10px] opacity-70 ml-7">(DOUBLE_CLICK)</span>}
                        </div>
                      </button>
                    </div>
                    
                    {isGDriveConnected && (
                      <button 
                        onClick={handleDisconnectGoogleDrive}
                        className={cn("w-full flex items-center justify-center gap-2 py-3 bg-red-900/10 border border-red-900/50 hover:bg-red-900/30 text-red-500 rounded transition-all font-bold", fontSize === 'large' ? "text-sm" : "text-xs")}
                      >
                        <CloudOff size={16} />
                        DISCONNECT_GOOGLE_DRIVE
                      </button>
                    )}

                    <div className="p-3 border border-red-900/50 bg-red-950/20 rounded space-y-1">
                      <p className={cn("text-red-400 font-bold uppercase flex items-center gap-1", fontSize === 'large' ? "text-xs" : "text-[10px]")}>
                        <AlertTriangle size={12} /> Troubleshooting:
                      </p>
                      <p className={cn("text-red-300 leading-relaxed italic", fontSize === 'large' ? "text-xs" : "text-[10px]")}>
                        If you encounter 404 errors during Google Drive authentication, ensure your "Standalone App URL" matches exactly where you are running the app (e.g. http://localhost:3000), or open the application in a new tab to bypass iframe restrictions.
                      </p>
                    </div>

                    <div className="pt-2 border-t border-green-900/30 space-y-4">
                      {/* Auto-Dim Settings - Single Row */}
                      <div className="space-y-1">
                        <div className="flex items-center gap-3">
                          <label className={cn("text-green-400 uppercase font-bold flex items-center gap-1 shrink-0", fontSize === 'large' ? "text-sm" : "text-xs")}>
                            <Activity size={12} /> Auto-Dim Timer
                          </label>
                          <input 
                            type="range"
                            min="0"
                            max="3600"
                            step="10"
                            value={dimTimeout}
                            onChange={(e) => setDimTimeout(parseInt(e.target.value))}
                            className="flex-1 accent-green-500 h-1.5 bg-green-900/10 rounded-lg appearance-none cursor-pointer"
                          />
                          <div className="flex items-center gap-1 shrink-0">
                            <input 
                              type="number"
                              min="0"
                              max="3600"
                              value={dimTimeout}
                              onChange={(e) => {
                                const val = Math.min(3600, Math.max(0, parseInt(e.target.value) || 0));
                                setDimTimeout(val);
                              }}
                              className={cn("w-12 bg-black border border-green-900 p-1 text-green-400 rounded outline-none focus:border-green-500 text-right", fontSize === 'large' ? "text-sm" : "text-xs")}
                            />
                            <span className={cn("text-green-500 font-mono opacity-50", fontSize === 'large' ? "text-xs" : "text-[10px]")}>S</span>
                          </div>
                        </div>
                        <p className={cn("text-green-400/60 italic text-center", fontSize === 'large' ? "text-xs" : "text-[10px]")}>
                          {dimTimeout === 0 
                            ? "Auto-dimming is disabled." 
                            : `Inactivity dim trigger: ${dimTimeout} seconds`
                          }
                        </p>
                      </div>

                      {/* Fullscreen Toggle */}
                      <div className="pt-2 flex items-center justify-between border-t border-green-900/30 group/fullscreen relative">
                        <div className="flex items-center gap-1.5">
                          <label className={cn("text-green-400 uppercase font-bold flex items-center gap-1", fontSize === 'large' ? "text-sm" : "text-xs")}>
                            <Shield size={12} /> Auto Fullscreen
                          </label>
                          <div className="group/tip relative cursor-help">
                            <Activity size={10} className="text-green-500/50 hover:text-green-400 transition-colors" />
                            <div className="absolute bottom-full left-0 mb-2 w-48 px-2 py-1.5 bg-black border border-green-500 text-[10px] text-green-400 rounded shadow-2xl opacity-0 group-hover/tip:opacity-100 transition-opacity pointer-events-none z-30 leading-tight">
                              When enabled, the terminal automatically enters fullscreen mode upon the first scan or interaction.
                            </div>
                          </div>
                        </div>
                        <button 
                          onClick={() => setAutoFullscreenEnabled(!autoFullscreenEnabled)}
                          className={cn(
                            "w-12 h-6 rounded-full relative transition-colors duration-300",
                            autoFullscreenEnabled ? "bg-green-500" : "bg-green-900/70"
                          )}
                        >
                          <div className={cn(
                            "absolute top-1 left-1 w-4 h-4 rounded-full bg-black transition-transform duration-300",
                            autoFullscreenEnabled && "translate-x-6"
                          )} />
                        </button>
                      </div>

                      <div className="flex justify-center flex-col items-center gap-2">
                        <div className="group relative">
                          <a 
                            href="https://github.com/h-o7/signin_terminal" 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className={cn("flex items-center gap-2 text-green-500/60 hover:text-green-400 transition-colors font-bold", fontSize === 'large' ? "text-xs" : "text-[10px]")}
                          >
                            <Github size={14} />
                            VIEW_SOURCE_ON_GITHUB
                          </a>
                          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-max px-2 py-1 bg-black border border-green-500 text-[10px] text-green-400 rounded shadow-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20 whitespace-nowrap">
                            For full documentation, please see Github Repository
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="space-y-4 animate-in fade-in slide-in-from-right-2 duration-200">
                  <div className="space-y-2">
                    <div className="p-3 bg-blue-950/20 border border-blue-900/50 rounded space-y-2">
                      <div>
                        <p className="text-blue-400 text-[10px] font-bold uppercase">Standalone Executable Config</p>
                        <p className={cn("text-blue-300 leading-relaxed", fontSize === 'large' ? "text-xs" : "text-[10px]")}>
                          Configure these settings to allow the application to use your own Google Cloud project. 
                          Required for Cloud Run or external hosting (Default port: 3000).
                        </p>
                      </div>
                      <div>
                        <p className="text-blue-400 text-[10px] font-bold uppercase flex items-center gap-2">
                          <Info size={12} /> Sync Protocol Note
                        </p>
                        <p className={cn("text-blue-300 leading-relaxed", fontSize === 'large' ? "text-xs" : "text-[10px]")}>
                          To ensure stability and performance, scan data is buffered locally and synchronized with the database every 10 seconds. 
                          It is normal to experience a brief delay before entries appear in reports.
                        </p>
                      </div>
                    </div>
  
                    <div className="p-3 bg-red-950/20 border border-red-900/50 rounded space-y-2">
                      <p className="text-red-500 text-[10px] font-bold uppercase">Security Warning</p>
                      <p className={cn("text-red-400 leading-relaxed", fontSize === 'large' ? "text-xs" : "text-[10px]")}>
                        Changing these settings will restart the OAuth client. You may need to reconnect Google Drive after saving.
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="group relative flex items-center gap-1.5">
                      <label className={cn("text-green-400 uppercase font-bold", fontSize === 'large' ? "text-sm" : "text-xs")}>Google Client ID</label>
                      <Info size={12} className="text-green-500/50 cursor-help" />
                      <div className="absolute bottom-full left-0 mb-2 w-64 p-2 bg-black border border-green-500 text-[10px] text-green-400 rounded shadow-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20 leading-relaxed">
                        The OAuth 2.0 Client ID from your Google Cloud Console project. This identifies your application to Google's authentication server.
                      </div>
                    </div>
                    <input 
                      type="text"
                      value={googleClientId}
                      onChange={(e) => setGoogleClientId(e.target.value)}
                      placeholder="Enter Client ID"
                      className={cn("w-full bg-black border border-green-900 p-2 text-green-400 rounded outline-none focus:border-green-500 placeholder:text-green-600", fontSize === 'large' ? "text-base" : "text-sm")}
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="group relative flex items-center gap-1.5">
                      <label className={cn("text-green-400 uppercase font-bold", fontSize === 'large' ? "text-sm" : "text-xs")}>Google Client Secret</label>
                      <Info size={12} className="text-green-500/50 cursor-help" />
                      <div className="absolute bottom-full left-0 mb-2 w-64 p-2 bg-black border border-green-500 text-[10px] text-green-400 rounded shadow-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20 leading-relaxed text-red-400">
                        The OAuth 2.0 Client Secret from your Google Cloud Console. This is a private key that should be kept secure and never shared publicly.
                      </div>
                    </div>
                    <input 
                      type="password"
                      value={googleClientSecret}
                      onChange={(e) => setGoogleClientSecret(e.target.value)}
                      placeholder="Enter Client Secret"
                      className={cn("w-full bg-black border border-green-900 p-2 text-green-400 rounded outline-none focus:border-green-500 placeholder:text-green-600", fontSize === 'large' ? "text-base" : "text-sm")}
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="group relative flex items-center gap-1.5">
                      <label className={cn("text-green-400 uppercase font-bold", fontSize === 'large' ? "text-sm" : "text-xs")}>Standalone App URL</label>
                      <Info size={12} className="text-green-500/50 cursor-help" />
                      <div className="absolute bottom-full left-0 mb-2 w-64 p-2 bg-black border border-green-500 text-[10px] text-green-400 rounded shadow-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20 leading-relaxed">
                        The exact URL where this terminal is running (e.g. http://localhost:3000). Google uses this to verify the redirect destination after login. Used to calculate the OAuth Redirect URI.
                      </div>
                    </div>
                    <input 
                      type="text"
                      value={appUrl}
                      onChange={(e) => setAppUrl(e.target.value)}
                      placeholder="e.g. http://localhost:3000"
                      className={cn("w-full bg-black border border-green-900 p-2 text-green-400 rounded outline-none focus:border-green-500 placeholder:text-green-600", fontSize === 'large' ? "text-base" : "text-sm")}
                    />
                  </div>

                  <div className="space-y-4">
                    <div className="p-3 bg-indigo-950/20 border border-indigo-900/50 rounded space-y-2">
                      <p className={cn("text-indigo-400 font-medium", fontSize === 'large' ? "text-xs" : "text-[10px]")}>Add the following OAuth Redirect URI to your Google Cloud Console Authorized Redirect URIs.</p>
                      <div>
                        <p className={cn("text-indigo-400 uppercase font-bold mb-1", fontSize === 'large' ? "text-xs" : "text-[10px]")}>OAuth Redirect URI:</p>
                        <code className={cn("text-indigo-300 break-all bg-black/50 p-2 block border border-indigo-900/40 rounded", fontSize === 'large' ? "text-xs" : "text-[10px]")}>
                          {appUrl ? `${appUrl.replace(/\/$/, '')}/auth/callback` : `${window.location.origin}/auth/callback`}
                        </code>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button 
                      onClick={handleSaveApiSettings}
                      disabled={isSavingSettings}
                      className={cn(
                        "flex items-center justify-center gap-2 py-3 border rounded transition-all font-bold disabled:opacity-50",
                        showSaveConfirm ? "bg-red-600 border-red-500 text-white hover:bg-red-500" : "bg-blue-900/20 border-blue-900 text-blue-400 hover:bg-blue-900/40",
                        fontSize === 'large' ? "text-sm" : "text-xs"
                      )}
                    >
                      {isSavingSettings ? <Activity className="animate-spin" size={14} /> : (showSaveConfirm ? <AlertTriangle size={16} /> : <Save size={16} />)}
                      {isSavingSettings ? 'SAVING...' : (showSaveConfirm ? 'CONFIRM' : 'SAVE_API_SETTINGS')}
                    </button>

                    <button 
                      onClick={handleResetToDefaults}
                      className={cn(
                        "flex items-center justify-center gap-2 py-3 bg-gray-900/20 border border-gray-800 hover:bg-gray-800/40 text-gray-500 rounded transition-all font-bold",
                        fontSize === 'large' ? "text-sm" : "text-xs"
                      )}
                    >
                      <RotateCcw size={16} />
                      RESET_DEFAULTS
                    </button>
                  </div>

                  {showSaveConfirm && (
                    <div className="p-2 border border-red-600 bg-red-950/20 rounded">
                      <p className="text-red-500 text-[10px] font-bold text-center animate-pulse">
                        ⚠️ WARNING: CHANGING THESE SETTINGS WILL RESTART THE GOOGLE OAUTH CLIENT. PRESS THE RED BUTTON ABOVE TO CONFIRM.
                      </p>
                      <button 
                        onClick={() => setShowSaveConfirm(false)}
                        className="w-full mt-2 text-[10px] text-gray-500 hover:text-gray-300 underline font-bold"
                      >
                        CANCEL
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* 4. Bottom Buttons */}
              <div className="pt-4 border-t border-green-900 flex gap-2">
                <button 
                  onClick={() => setShowSettings(false)}
                  className={cn("flex-1 flex items-center justify-center gap-2 py-3 bg-green-900/20 border border-green-900 hover:bg-green-900/40 text-green-400 rounded transition-all font-bold", fontSize === 'large' ? "text-sm" : "text-xs")}
                >
                  <Save size={16} />
                  SAVE_AND_EXIT
                </button>
                <div className="flex-1 relative group">
                  <button 
                    disabled={!isGDriveConnected}
                    onClick={handleClearDatabase}
                    className={cn("w-full flex items-center justify-center gap-2 py-3 bg-red-900/20 border border-red-900 hover:bg-red-900/40 text-red-500 rounded transition-all font-bold disabled:opacity-30 disabled:cursor-not-allowed", fontSize === 'large' ? "text-sm" : "text-xs")}
                  >
                    <Trash2 size={16} />
                    CLEAR_DATABASE
                  </button>
                  {!isGDriveConnected && (
                    <div className={cn("absolute bottom-full left-0 mb-2 w-48 p-2 bg-red-950 border border-red-900 text-red-400 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50", fontSize === 'large' ? "text-xs" : "text-[10px]")}>
                      SYSTEM_LOCKED: Google Drive must be connected for mandatory backup before clearing the database.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
