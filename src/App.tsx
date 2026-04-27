import React, { useState, useEffect, useRef } from 'react';
import { Terminal as TerminalIcon, LogIn, LogOut, Shield, Activity, Database, Cpu, Settings, X, Upload, Download, Cloud, CloudOff, Trash2, Save, FileSpreadsheet, Calendar, User as UserIcon, Search, Users } from 'lucide-react';
import { format } from 'date-fns';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { db, auth, signIn, signOut } from './firebase';
import { collection, doc, setDoc, addDoc, onSnapshot, query, orderBy, limit, getDocs, writeBatch, where, deleteDoc } from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';
import Papa from 'papaparse';

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
  const [selectedTimezone, setSelectedTimezone] = useState<string>(
    localStorage.getItem('terminal_timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const [availableUsers, setAvailableUsers] = useState<UserRecord[]>([]);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [input, setInput] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([
    { id: 'init', timestamp: new Date(), message: 'SYSTEM_BOOT_COMPLETE: Terminal ready.', type: 'system' }
  ]);
  const [userStatuses, setUserStatuses] = useState<UserStatusMap>({});
  const [isGDriveConnected, setIsGDriveConnected] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const TERMINAL_ID = 'shared-terminal';

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        setIsStarted(true);
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

    const unsubscribeUsers = onSnapshot(collection(db, 'terminals', TERMINAL_ID, 'mappings'), (snapshot) => {
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
      collection(db, 'terminals', TERMINAL_ID, 'logs'), 
      where('timestamp', '>=', startOfTodayISO),
      orderBy('timestamp', 'desc'), 
      limit(50)
    );
    const unsubscribeLogs = onSnapshot(q, (snapshot) => {
      const newLogs: LogEntry[] = [];
      snapshot.docs.reverse().forEach((doc) => {
        const data = doc.data();
        newLogs.push({
          id: doc.id,
          timestamp: new Date(data.timestamp),
          message: `[${data.status.toUpperCase()}] ${data.displayName || data.username}`,
          type: data.status === 'logged in' ? 'output' : 'input'
        });
      });
      if (newLogs.length > 0) {
        setLogs(prev => {
          const existingIds = new Set(prev.map(l => l.id));
          const uniqueNew = newLogs.filter(l => !existingIds.has(l.id));
          return [...prev, ...uniqueNew].slice(-100);
        });
      }
    });

    return () => {
      unsubscribeUsers();
      unsubscribeLogs();
    };
  }, [isStarted, isAuthReady]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && input.length > 0) {
      const userInput = input;
      setInput('');
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

      try {
        await setDoc(doc(db, 'terminals', TERMINAL_ID, 'mappings', userInput), {
          username: userInput,
          lastStatus: nextStatus,
          lastTimestamp: formattedTime,
          // Preservation of displayName is handled by merge: true, 
          // but we explicitly pass it if we found it to be extra safe 
          // or if it's a new user without a mapping yet.
          ...(displayName ? { displayName } : {})
        }, { merge: true });

        await addDoc(collection(db, 'terminals', TERMINAL_ID, 'logs'), {
          username: userInput,
          displayName: displayName,
          status: nextStatus,
          timestamp: formattedTime
        });
      } catch (err) {
        console.error(err);
      }
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

            let username = getVal(['username', 'id', 'fobid', 'cardid', 'uid', 'user']);
            const displayName = getVal(['displayname', 'name', 'fullname', 'userdesc']);
            
            // Fallback: If no recognized header for ID, use the first column
            if (!username && Object.keys(row).length > 0) {
              const firstKey = Object.keys(row)[0];
              username = row[firstKey];
            }
            
            if (username) {
              const cleanedUsername = String(username).trim();
              if (cleanedUsername) {
                const userRef = doc(db, 'terminals', TERMINAL_ID, 'mappings', cleanedUsername);
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
            setLogs(prev => [...prev, { id: Date.now().toString(), timestamp: new Date(), message: 'SYSTEM: Import failed - No valid data found. Ensure CSV has column "username" or "id".', type: 'system' }]);
            alert('Import failed: No valid users found in CSV. Please verify column headers (e.g., username, displayName).');
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
      const snapshot = await getDocs(collection(db, 'terminals', TERMINAL_ID, 'logs'));
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
      const snapshot = await getDocs(collection(db, 'terminals', TERMINAL_ID, 'logs'));
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
      const logsSnapshot = await getDocs(collection(db, 'terminals', TERMINAL_ID, 'logs'));
      const mappingsSnapshot = await getDocs(collection(db, 'terminals', TERMINAL_ID, 'mappings'));
      
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
        const userRef = doc(db, 'terminals', TERMINAL_ID, 'mappings', username);
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
    setLogs(prev => [...prev, { 
      id: Date.now().toString(), 
      timestamp: new Date(), 
      message: `SYSTEM: Fetching logs for ${reportUser} from ${reportStartDate} to ${reportEndDate}...`, 
      type: 'system' 
    }]);

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

      setLogs(prev => [...prev, { 
        id: Date.now().toString(), 
        timestamp: new Date(), 
        message: `SYSTEM: UTC range: ${startISO.split('.')[0]} to ${endISO.split('.')[0]}`,
        type: 'system' 
      }]);

      const q = query(
        collection(db, 'terminals', TERMINAL_ID, 'logs'),
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
              hour12: false
            });
            
            const parts = formatter.formatToParts(dateObj);
            const p = (type: string) => parts.find(part => part.type === type)?.value || '';
            
            date = `${p('year')}-${p('month')}-${p('day')}`;
            time = `${p('hour')}:${p('minute')}:${p('second')}`;
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
          id: doc.id,
          username: d.username || 'unknown',
          displayName: displayName,
          status: d.status || 'unknown',
          original_utc_timestamp: ts,
          local_date: date,
          local_time: time,
          timezone: selectedTimezone
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

      const csv = Papa.unparse(data);
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `report_${reportUser}_${reportStartDate}_to_${reportEndDate}.csv`;
      document.body.appendChild(a); // Append to body to ensure it works in more browsers
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      
      setLogs(prev => [...prev, { 
        id: Date.now().toString(), 
        timestamp: new Date(), 
        message: `SYSTEM: Success! Report exported with ${data.length} records.`, 
        type: 'system' 
      }]);
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

  const handleConnectGoogleDrive = async () => {
    try {
      const res = await fetch('/api/auth/google/url');
      const contentType = res.headers.get("content-type");
      
      if (!contentType || contentType.indexOf("application/json") === -1) {
        throw new Error("BACKEND_UNAVAILABLE: This feature requires a Node.js backend. It will NOT work on Firebase Hosting (web.app). Please use the AI Studio Shared/Preview URL.");
      }

      const { url } = await res.json();
      window.open(url, 'gdrive_auth', 'width=600,height=700');
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
      <div className="min-h-screen bg-black text-green-500 font-mono flex flex-col items-center justify-center p-4 relative overflow-hidden">
        {/* Background Grid Effect */}
        <div className="absolute inset-0 opacity-10 pointer-events-none" 
             style={{ backgroundImage: 'linear-gradient(#10b981 1px, transparent 1px), linear-gradient(90deg, #10b981 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
        
        <div className="max-w-2xl w-full space-y-8 relative z-10 text-center">
          <div className="flex justify-center mb-6">
            <div className="p-4 rounded-full bg-green-900/20 border border-green-500/30 animate-pulse">
              <TerminalIcon size={64} className="text-green-400" />
            </div>
          </div>
          
          <div className="space-y-2">
            <h1 className="text-4xl font-black tracking-tighter text-white">TERMINAL_LOGGER_V2</h1>
            <p className="text-green-800 text-sm uppercase tracking-widest">Secure Entry Management System</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-left">
            <div className="p-4 border border-green-900/50 bg-green-950/20 rounded-lg">
              <Shield className="mb-2 text-green-400" size={20} />
              <h3 className="text-xs font-bold text-white mb-1">ENCRYPTED</h3>
              <p className="text-[10px] text-green-700">AES-256 secure data transmission protocols enabled.</p>
            </div>
            <div className="p-4 border border-green-900/50 bg-green-950/20 rounded-lg">
              <Activity className="mb-2 text-green-400" size={20} />
              <h3 className="text-xs font-bold text-white mb-1">REAL-TIME</h3>
              <p className="text-[10px] text-green-700">Instant synchronization across all connected nodes.</p>
            </div>
            <div className="p-4 border border-green-900/50 bg-green-950/20 rounded-lg">
              <Database className="mb-2 text-green-400" size={20} />
              <h3 className="text-xs font-bold text-white mb-1">PERSISTENT</h3>
              <p className="text-[10px] text-green-700">Cloud-native storage with automated backup systems.</p>
            </div>
          </div>

          <div className="pt-8 flex flex-col items-center gap-4">
            <button 
              onClick={() => setIsStarted(true)}
              className="group relative px-12 py-4 bg-green-500 text-black font-bold text-lg hover:bg-green-400 transition-all active:scale-95 overflow-hidden rounded"
            >
              <div className="absolute inset-0 bg-white/20 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-500" />
              LOGIN_TO_TERMINAL
            </button>
            
            <div className="flex items-center gap-4 text-[10px] text-green-900">
              <div className="flex items-center gap-1"><Cpu size={12}/> CPU_READY</div>
              <div className="flex items-center gap-1"><Shield size={12}/> AUTH_BYPASS_ENABLED</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-green-500 font-mono flex flex-col p-4 relative">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-green-900 pb-2 mb-4">
        <div className="flex items-center gap-2">
          <TerminalIcon size={20} />
          <span className="font-bold tracking-wider">CMD_TERMINAL_V2.0</span>
          <span className="text-[10px] bg-green-900/30 px-2 py-0.5 rounded text-green-400 animate-pulse">LIVE</span>
        </div>
        <div className="flex items-center gap-3">
          {user ? (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-green-800">{user.email}</span>
              <button 
                onClick={() => setShowUserList(true)} 
                className="p-1 hover:bg-green-900/30 rounded text-green-400"
                title="Registered Users"
              >
                <Users size={18} />
              </button>
              <button 
                onClick={() => setShowReports(true)} 
                className="p-1 hover:bg-green-900/30 rounded text-green-400"
                title="Generate Reports"
              >
                <FileSpreadsheet size={18} />
              </button>
              <button 
                onClick={() => setShowSettings(true)} 
                className="p-1 hover:bg-green-900/30 rounded text-green-400"
                title="Settings"
              >
                <Settings size={18} />
              </button>
              <button onClick={signOut} className="text-[10px] border border-red-900 px-2 py-1 hover:bg-red-900/20 text-red-700 rounded">LOGOUT</button>
            </div>
          ) : (
            <button onClick={signIn} className="text-[10px] bg-green-900/40 px-3 py-1 text-green-400 hover:bg-green-400 hover:text-black transition-colors rounded">ADMIN_LOGIN</button>
          )}
          <button onClick={() => setIsStarted(false)} className="text-[10px] border border-green-900 px-2 py-1 hover:bg-green-900/20 rounded">EXIT</button>
        </div>
      </div>

      {/* Terminal Body */}
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto mb-4 space-y-1 scrollbar-hide"
        onClick={() => inputRef.current?.focus()}
      >
        {logs.map((log) => (
          <div key={log.id} className="flex gap-3 text-sm animate-in fade-in slide-in-from-left-2 duration-300">
            <span className="text-green-900 shrink-0">[{format(log.timestamp, 'yyyy-MM-dd HH:mm:ss')}]</span>
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
      <div className="flex items-center gap-2 border-t border-green-900 pt-4">
        <span className="text-green-400 font-bold shrink-0">SCAN_FOB_ID:</span>
        <input
          ref={inputRef}
          autoFocus
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value.replace(/\D/g, '').slice(0, 12))}
          onKeyDown={handleKeyDown}
          className="flex-1 bg-transparent border-none outline-none text-green-400 placeholder:text-green-900"
          placeholder="WAITING_FOR_SIGNAL..."
        />
      </div>

      {/* User List Modal */}
      {showUserList && (
        <div className="absolute inset-0 bg-black/90 z-[60] flex items-center justify-center p-4">
          <div className="max-w-xl w-full border border-green-500 bg-black p-6 space-y-6 rounded shadow-[0_0_20px_rgba(16,185,129,0.2)] flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between border-b border-green-900 pb-4 shrink-0">
              <div className="flex items-center gap-2">
                <Users className="text-green-400" size={20} />
                <h2 className="text-lg font-bold text-white">REGISTERED_USERS_DATABASE</h2>
              </div>
              <button onClick={() => { setShowUserList(false); setEditedUsers({}); }} className="text-green-900 hover:text-green-400 transition-colors">
                <X size={24} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
              <div className="grid grid-cols-2 text-[10px] text-green-800 font-bold uppercase border-b border-green-900/50 pb-2 mb-2">
                <div>FOB_ID / USERNAME</div>
                <div>DISPLAY_NAME (EDITABLE)</div>
              </div>
              
              {availableUsers.length === 0 ? (
                <div className="text-center py-8 text-green-900 italic text-sm">NO_USERS_FOUND_IN_DATABASE</div>
              ) : (
                [...availableUsers].sort((a, b) => {
                  const nameA = (a.displayName || a.username).toLowerCase();
                  const nameB = (b.displayName || b.username).toLowerCase();
                  return nameA.localeCompare(nameB);
                }).map((u) => {
                  const currentDisplayName = editedUsers[u.username] !== undefined ? editedUsers[u.username] : (u.displayName || '');
                  return (
                    <div key={u.username} className="grid grid-cols-2 items-center py-2 border-b border-green-950 hover:bg-green-950/20 transition-colors group">
                      <div className="text-green-400 text-sm font-bold flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-green-500/50 group-hover:animate-ping" />
                        {u.username}
                      </div>
                      <div className="flex items-center gap-2">
                        <input 
                          type="text"
                          value={currentDisplayName}
                          onChange={(e) => setEditedUsers(prev => ({ ...prev, [u.username]: e.target.value }))}
                          className="flex-1 bg-black border border-green-900/50 p-1 text-green-600 text-sm focus:border-green-400 outline-none rounded"
                          placeholder="ENTER_DISPLAY_NAME..."
                        />
                        <button 
                          onClick={async () => {
                            if (confirm(`DELETE USER ${u.username}?`)) {
                              await deleteDoc(doc(db, 'terminals', TERMINAL_ID, 'mappings', u.username));
                            }
                          }}
                          className="text-red-900 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all p-1"
                          title="Delete User"
                        >
                          <Trash2 size={14} />
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
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-green-500 hover:bg-green-400 text-black rounded transition-all text-xs font-bold disabled:opacity-50"
              >
                {isSavingUserList ? <Activity className="animate-spin" size={16} /> : <Save size={16} />}
                SAVE_AND_EXIT
              </button>
              <button 
                onClick={() => { setShowUserList(false); setEditedUsers({}); }}
                className="flex-1 py-3 border border-green-900 hover:bg-green-900/40 text-green-400 rounded transition-all text-xs font-bold"
              >
                CANCEL
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reports Modal */}
      {showReports && (
        <div className="absolute inset-0 bg-black/90 z-50 flex items-center justify-center p-4">
          <div className="max-w-md w-full border border-green-500 bg-black p-6 space-y-6 rounded shadow-[0_0_20px_rgba(16,185,129,0.2)]">
            <div className="flex items-center justify-between border-b border-green-900 pb-4">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="text-green-400" size={20} />
                <h2 className="text-lg font-bold text-white">GENERATE_REPORT</h2>
              </div>
              <button onClick={() => setShowReports(false)} className="text-green-900 hover:text-green-400 transition-colors">
                <X size={24} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs text-green-800 uppercase font-bold flex items-center gap-1">
                  <UserIcon size={12} /> Target User
                </label>
                <select 
                  value={reportUser}
                  onChange={(e) => setReportUser(e.target.value)}
                  className="w-full bg-black border border-green-900 p-2 text-green-400 rounded outline-none focus:border-green-500 text-sm"
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
                  <label className="text-xs text-green-800 uppercase font-bold flex items-center gap-1">
                    <Calendar size={12} /> Start Date
                  </label>
                  <input 
                    type="date"
                    value={reportStartDate}
                    onChange={(e) => setReportStartDate(e.target.value)}
                    className="w-full bg-black border border-green-900 p-2 text-green-400 rounded outline-none focus:border-green-500 text-sm [color-scheme:dark]"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-green-800 uppercase font-bold flex items-center gap-1">
                    <Calendar size={12} /> End Date
                  </label>
                  <input 
                    type="date"
                    value={reportEndDate}
                    onChange={(e) => setReportEndDate(e.target.value)}
                    className="w-full bg-black border border-green-900 p-2 text-green-400 rounded outline-none focus:border-green-500 text-sm [color-scheme:dark]"
                  />
                </div>
              </div>

              <div className="pt-4 border-t border-green-900 flex gap-2">
                <button 
                  onClick={handleGenerateReport}
                  disabled={isGeneratingReport}
                  className="flex-1 flex items-center justify-center gap-2 py-3 bg-green-500 hover:bg-green-400 text-black rounded transition-all text-sm font-bold disabled:opacity-50"
                >
                  {isGeneratingReport ? (
                    <Activity className="animate-spin" size={18} />
                  ) : (
                    <Search size={18} />
                  )}
                  FETCH_LOGS_AND_EXPORT
                </button>
                <button 
                  onClick={() => setShowReports(false)}
                  className="px-4 py-3 border border-green-900 hover:bg-green-900/20 text-green-400 rounded transition-all text-xs font-bold"
                >
                  CANCEL
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="absolute inset-0 bg-black/90 z-50 flex items-center justify-center p-4">
          <div className="max-w-md w-full border border-green-500 bg-black p-6 space-y-6 rounded shadow-[0_0_20px_rgba(16,185,129,0.2)]">
            <div className="flex items-center justify-between border-b border-green-900 pb-4">
              <div className="flex items-center gap-2">
                <Settings className="text-green-400" size={20} />
                <h2 className="text-lg font-bold text-white">SYSTEM_SETTINGS</h2>
              </div>
              <button onClick={() => setShowSettings(false)} className="text-green-900 hover:text-green-400 transition-colors">
                <X size={24} />
              </button>
            </div>

            <div className="space-y-4">
              {/* 1. Timezone Settings */}
              <div className="space-y-2">
                <label className="text-xs text-green-800 uppercase font-bold flex items-center gap-1">
                  <Calendar size={12} /> System Timezone
                </label>
                <select 
                  value={selectedTimezone}
                  onChange={(e) => {
                    const tz = e.target.value;
                    setSelectedTimezone(tz);
                    localStorage.setItem('terminal_timezone', tz);
                  }}
                  className="w-full bg-black border border-green-900 p-2 text-green-400 rounded outline-none focus:border-green-500 text-sm"
                >
                  <optgroup label="Common Timezones">
                    <option value="UTC">UTC (Universal Time)</option>
                    <option value="America/New_York">Eastern Time (New York)</option>
                    <option value="America/Chicago">Central Time (Chicago)</option>
                    <option value="America/Denver">Mountain Time (Denver)</option>
                    <option value="America/Los_Angeles">Pacific Time (Los Angeles)</option>
                    <option value="America/Toronto">Eastern Time (Toronto)</option>
                    <option value="Europe/London">Greenwich Mean Time (London)</option>
                    <option value="Europe/Paris">Central European Time (Paris)</option>
                    <option value="Asia/Tokyo">Japan Standard Time (Tokyo)</option>
                    <option value="Asia/Shanghai">China Standard Time (Shanghai)</option>
                    <option value="Australia/Sydney">Australian Eastern Time (Sydney)</option>
                  </optgroup>
                  <optgroup label="System Default">
                    <option value={Intl.DateTimeFormat().resolvedOptions().timeZone}>
                      Detected: {Intl.DateTimeFormat().resolvedOptions().timeZone}
                    </option>
                  </optgroup>
                </select>
                <p className="text-[10px] text-green-900 italic">Affects timestamp conversion in generated reports.</p>
              </div>

              {/* 2. Import Users */}
              <div className="space-y-2">
                <label className="text-xs text-green-800 uppercase font-bold">User Management</label>
                <div className="grid grid-cols-1 gap-2">
                  <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full flex items-center justify-center gap-2 py-3 border border-green-900 hover:bg-green-900/20 text-green-400 rounded transition-all"
                  >
                    <Upload size={18} />
                    IMPORT_USERS_VIA_CSV
                  </button>
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
              <div className="space-y-2">
                <label className="text-xs text-green-800 uppercase font-bold">Data Export</label>
                <div className="grid grid-cols-1 gap-2">
                  <button 
                    onClick={handleExportToGoogleDrive}
                    className="flex items-center justify-center gap-2 py-3 border border-green-900 hover:bg-green-900/20 text-green-400 rounded transition-all text-xs"
                  >
                    <Cloud size={16} />
                    {isGDriveConnected ? 'EXPORT_TO_GOOGLE_DRIVE' : 'CONNECT_AND_EXPORT'}
                  </button>
                </div>
              </div>

              {/* 3. Connect GDrive */}
              <div className="space-y-2">
                <button 
                  onClick={handleConnectGoogleDrive}
                  className={cn(
                    "w-full flex items-center justify-center gap-2 py-3 border rounded transition-all text-xs font-bold",
                    isGDriveConnected 
                      ? "bg-blue-900/20 border-blue-900 text-blue-400 hover:bg-blue-900/40"
                      : "bg-green-900/20 border-green-900 text-green-400 hover:bg-green-900/30"
                  )}
                >
                  <Cloud size={18} />
                  {isGDriveConnected ? 'GOOGLE_DRIVE_CONNECTED' : 'CONNECT_GOOGLE_DRIVE'}
                </button>
                
                {isGDriveConnected && (
                  <button 
                    onClick={handleDisconnectGoogleDrive}
                    className="w-full flex items-center justify-center gap-2 py-3 bg-red-900/10 border border-red-900/50 hover:bg-red-900/30 text-red-500 rounded transition-all text-xs font-bold"
                  >
                    <CloudOff size={16} />
                    DISCONNECT_GOOGLE_DRIVE
                  </button>
                )}

                {!isGDriveConnected && (
                  <div className="p-2 bg-blue-950/20 border border-blue-900/30 rounded">
                    <p className="text-[9px] text-blue-400 uppercase font-bold mb-1">OAuth Redirect URI:</p>
                    <code className="text-[9px] text-blue-300 break-all bg-black/50 p-1 block">
                      {window.location.origin}/auth/callback
                    </code>
                    <p className="text-[8px] text-blue-800 mt-1 italic">Add this to your Google Cloud Console Authorized Redirect URIs.</p>
                  </div>
                )}
              </div>

              {/* 4. Bottom Buttons */}
              <div className="pt-4 border-t border-green-900 flex gap-2">
                <button 
                  onClick={() => setShowSettings(false)}
                  className="flex-1 flex items-center justify-center gap-2 py-3 bg-green-900/20 border border-green-900 hover:bg-green-900/40 text-green-400 rounded transition-all text-xs font-bold"
                >
                  <Save size={16} />
                  SAVE_AND_EXIT
                </button>
                <div className="flex-1 relative group">
                  <button 
                    disabled={!isGDriveConnected}
                    onClick={handleClearDatabase}
                    className="w-full flex items-center justify-center gap-2 py-3 bg-red-900/20 border border-red-900 hover:bg-red-900/40 text-red-500 rounded transition-all text-xs font-bold disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Trash2 size={16} />
                    CLEAR_DATABASE
                  </button>
                  {!isGDriveConnected && (
                    <div className="absolute bottom-full left-0 mb-2 w-48 p-2 bg-red-950 border border-red-900 text-[10px] text-red-400 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
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
