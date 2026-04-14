import React, { useState, useEffect, useRef } from 'react';
import { Terminal as TerminalIcon, LogIn, LogOut, Shield, Activity, Database, Cpu, Settings, X, Upload, Download, Cloud, Trash2, Save } from 'lucide-react';
import { format } from 'date-fns';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { db, auth, signIn, signOut } from './firebase';
import { collection, doc, setDoc, addDoc, onSnapshot, query, orderBy, limit, getDocs, writeBatch } from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';
import Papa from 'papaparse';

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Check GDrive Status
  useEffect(() => {
    if (user) {
      fetch('/api/auth/google/status')
        .then(res => res.json())
        .then(data => setIsGDriveConnected(data.connected))
        .catch(err => console.error('Error checking GDrive status:', err));
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
      snapshot.forEach((doc) => {
        const data = doc.data();
        statuses[doc.id] = {
          lastStatus: data.lastStatus,
          lastDate: data.lastTimestamp?.split('T')[0] || '',
          lastFullTimestamp: data.lastTimestamp || ''
        };
      });
      setUserStatuses(statuses);
    });

    const q = query(collection(db, 'terminals', TERMINAL_ID, 'logs'), orderBy('timestamp', 'desc'), limit(50));
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
      let nextStatus: 'logged in' | 'logged out' = 'logged in';
      if (currentStatus && currentStatus.lastDate === currentDate) {
        nextStatus = currentStatus.lastStatus === 'logged in' ? 'logged out' : 'logged in';
      }

      try {
        await setDoc(doc(db, 'terminals', TERMINAL_ID, 'mappings', userInput), {
          username: userInput,
          lastStatus: nextStatus,
          lastTimestamp: formattedTime
        }, { merge: true });

        await addDoc(collection(db, 'terminals', TERMINAL_ID, 'logs'), {
          username: userInput,
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

    Papa.parse(file, {
      header: true,
      complete: async (results) => {
        const batch = writeBatch(db);
        results.data.forEach((row: any) => {
          if (row.username) {
            const userRef = doc(db, 'terminals', TERMINAL_ID, 'mappings', row.username);
            batch.set(userRef, {
              username: row.username,
              lastStatus: row.lastStatus || 'logged out',
              lastTimestamp: row.lastTimestamp || new Date().toISOString()
            }, { merge: true });
          }
        });
        await batch.commit();
        alert('Import complete');
      }
    });
  };

  const handleExportCSV = async () => {
    const snapshot = await getDocs(collection(db, 'terminals', TERMINAL_ID, 'logs'));
    const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const csv = Papa.unparse(data);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `terminal_logs_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
  };

  const handleClearDatabase = async () => {
    if (!confirm('ARE YOU SURE? THIS WILL PERMANENTLY DELETE ALL LOGS AND USER MAPPINGS.')) return;
    
    const logsSnapshot = await getDocs(collection(db, 'terminals', TERMINAL_ID, 'logs'));
    const mappingsSnapshot = await getDocs(collection(db, 'terminals', TERMINAL_ID, 'mappings'));
    
    const batch = writeBatch(db);
    logsSnapshot.docs.forEach(d => batch.delete(d.ref));
    mappingsSnapshot.docs.forEach(d => batch.delete(d.ref));
    
    await batch.commit();
    setLogs([{ id: 'clear', timestamp: new Date(), message: 'SYSTEM_WIPE_COMPLETE: All data purged.', type: 'system' }]);
    alert('Database cleared');
  };

  const handleConnectGoogleDrive = async () => {
    try {
      const res = await fetch('/api/auth/google/url');
      const { url } = await res.json();
      window.open(url, 'gdrive_auth', 'width=600,height=700');
    } catch (err) {
      console.error('Failed to get auth URL:', err);
      alert('Failed to initialize Google Drive connection.');
    }
  };

  const handleExportToGoogleDrive = async () => {
    if (!isGDriveConnected) {
      handleConnectGoogleDrive();
      return;
    }

    try {
      const snapshot = await getDocs(collection(db, 'terminals', TERMINAL_ID, 'logs'));
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const csv = Papa.unparse(data);

      const res = await fetch('/api/export/gdrive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csvData: csv,
          fileName: `terminal_logs_${format(new Date(), 'yyyy-MM-dd')}.csv`
        })
      });

      if (res.ok) {
        alert('Data exported to Google Drive successfully!');
      } else {
        const err = await res.json();
        alert(`Export failed: ${err.error}`);
      }
    } catch (err) {
      console.error('Export error:', err);
      alert('An error occurred during export.');
    }
  };

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
              <button onClick={() => setShowSettings(true)} className="p-1 hover:bg-green-900/30 rounded text-green-400">
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
            <span className="text-green-900 shrink-0">[{format(log.timestamp, 'HH:mm:ss')}]</span>
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
              {/* 1. Import Users */}
              <div className="space-y-2">
                <label className="text-xs text-green-800 uppercase font-bold">User Management</label>
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full flex items-center justify-center gap-2 py-3 border border-green-900 hover:bg-green-900/20 text-green-400 rounded transition-all"
                >
                  <Upload size={18} />
                  IMPORT_USERS_VIA_CSV
                </button>
                <input 
                  ref={fileInputRef}
                  type="file" 
                  accept=".csv" 
                  className="hidden" 
                  onChange={handleImportCSV}
                />
              </div>

              {/* 2 & 3. Export Data */}
              <div className="space-y-2">
                <label className="text-xs text-green-800 uppercase font-bold">Data Export</label>
                <div className="grid grid-cols-2 gap-2">
                  <button 
                    onClick={handleExportCSV}
                    className="flex items-center justify-center gap-2 py-3 border border-green-900 hover:bg-green-900/20 text-green-400 rounded transition-all text-xs"
                  >
                    <Download size={16} />
                    EXPORT_CSV
                  </button>
                  <button 
                    onClick={handleExportToGoogleDrive}
                    className="flex items-center justify-center gap-2 py-3 border border-green-900 hover:bg-green-900/20 text-green-400 rounded transition-all text-xs"
                  >
                    <Cloud size={16} />
                    {isGDriveConnected ? 'EXPORT_GDRIVE' : 'CONNECT_GDRIVE'}
                  </button>
                </div>
              </div>

              {/* 3. Connect GDrive */}
              <div className="space-y-2">
                <button 
                  onClick={handleConnectGoogleDrive}
                  className={cn(
                    "w-full flex items-center justify-center gap-2 py-3 border rounded transition-all",
                    isGDriveConnected 
                      ? "bg-green-900/20 border-green-900 text-green-400"
                      : "bg-blue-900/20 border-blue-900 text-blue-400 hover:bg-blue-900/40"
                  )}
                >
                  <Cloud size={18} />
                  {isGDriveConnected ? 'GOOGLE_DRIVE_CONNECTED' : 'CONNECT_GOOGLE_DRIVE'}
                </button>
                {!isGDriveConnected && (
                  <div className="p-2 bg-blue-950/20 border border-blue-900/30 rounded">
                    <p className="text-[9px] text-blue-400 uppercase font-bold mb-1">OAuth Redirect URI:</p>
                    <code className="text-[9px] text-blue-300 break-all bg-black/50 p-1 block">
                      {window.location.origin}/auth/callback
                    code>
                    <p className="text-[8px] text-blue-800 mt-1 italic">Add this to your Google Cloud Console Authorized Redirect URIs.</p>
                  </div>
                )}
              </div>

              {/* 4. Bottom Buttons */}
              <div className="pt-4 border-t border-green-900 flex gap-2">
                <button 
                  onClick={handleClearDatabase}
                  className="flex-1 flex items-center justify-center gap-2 py-3 bg-red-900/20 border border-red-900 hover:bg-red-900/40 text-red-500 rounded transition-all text-xs font-bold"
                >
                  <Trash2 size={16} />
                  CLEAR_DATABASE
                </button>
                <button 
                  onClick={() => setShowSettings(false)}
                  className="flex-1 flex items-center justify-center gap-2 py-3 bg-green-900/20 border border-green-900 hover:bg-green-900/40 text-green-400 rounded transition-all text-xs font-bold"
                >
                  <Save size={16} />
                  SAVE_AND_EXIT
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
