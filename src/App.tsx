import React, { useState, useEffect, useRef } from 'react';
import { Download, Settings, X, Upload, Link as LinkIcon, Terminal as TerminalIcon, ChevronRight, LogIn, LogOut, User as UserIcon } from 'lucide-react';
import Papa from 'papaparse';
import { format } from 'date-fns';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { db, auth, signIn, signOut } from './firebase';
import { collection, doc, setDoc, addDoc, onSnapshot, query, orderBy, limit, getDoc, getDocs, serverTimestamp } from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';

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

interface UserMapping {
  [key: string]: string;
}

interface UserStatus {
  lastStatus: 'logged in' | 'logged out';
  lastDate: string; // YYYY-MM-DD
  lastFullTimestamp: string; // ISO string
}

interface UserStatusMap {
  [key: string]: UserStatus;
}

export default function App() {
  console.log("[SYSTEM] APP_COMPONENT_MOUNTING");
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [input, setInput] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: 'init',
      timestamp: new Date(),
      message: 'Terminal initialized. Ready for input...',
      type: 'system',
    },
  ]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isDriveConnected, setIsDriveConnected] = useState(false);
  const [uploadedUserMap, setUploadedUserMap] = useState<UserMapping>(() => {
    try {
      const saved = localStorage.getItem('terminal_user_map');
      return saved ? JSON.parse(saved) : {};
    } catch (e) {
      return {};
    }
  });
  const [userStatuses, setUserStatuses] = useState<UserStatusMap>({});

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
      if (u) {
        setLogs(prev => [...prev, {
          id: `auth-${Date.now()}`,
          timestamp: new Date(),
          message: `Authenticated as ${u.email}`,
          type: 'system'
        }]);
      }
    });
    return () => unsubscribe();
  }, []);

  // Real-time Firestore Listeners
  useEffect(() => {
    if (!user) return;

    // Listen to user statuses for real-time toggle logic
    const unsubscribeUsers = onSnapshot(collection(db, 'terminals', user.uid, 'mappings'), (snapshot) => {
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

    // Listen to recent logs
    const q = query(collection(db, 'terminals', user.uid, 'logs'), orderBy('timestamp', 'desc'), limit(10));
    const unsubscribeLogs = onSnapshot(q, (snapshot) => {
      const firestoreLogs: LogEntry[] = snapshot.docs.reverse().map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
          message: `${data.displayName || data.username} ${data.status} at ${data.timestamp}`,
          type: 'output' as const
        };
      });
      
      // Keep the init log and merge with firestore logs
      setLogs(prev => {
        const initLog = prev.find(l => l.id === 'init');
        return initLog ? [initLog, ...firestoreLogs] : firestoreLogs;
      });
    });

    // Listen to user settings (for Drive connection status)
    const unsubscribeSettings = onSnapshot(doc(db, 'terminals', user.uid), (doc) => {
      if (doc.exists()) {
        setIsDriveConnected(!!doc.data().googleDriveRefreshToken);
      }
    });

    return () => {
      unsubscribeUsers();
      unsubscribeLogs();
      unsubscribeSettings();
    };
  }, [user]);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Persistence
  useEffect(() => {
    try {
      localStorage.setItem('terminal_user_map', JSON.stringify(uploadedUserMap));
    } catch (e) {}
  }, [uploadedUserMap]);

  useEffect(() => {
    try {
      localStorage.setItem('terminal_user_statuses', JSON.stringify(userStatuses));
    } catch (e) {}
  }, [userStatuses]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  // Focus input on click anywhere
  const handleTerminalClick = () => {
    inputRef.current?.focus();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/\D/g, '').slice(0, 12);
    setInput(value);
  };

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && input.length > 0) {
      if (!user) {
        alert("Please sign in to use the terminal.");
        return;
      }

      const timestamp = new Date();
      const formattedTime = timestamp.toISOString();
      const currentDate = format(timestamp, 'yyyy-MM-dd');
      
      const userInput = input;
      setInput('');

      // Rate limiting: Check if the same user scanned within the last 2 seconds
      const currentStatus = userStatuses[userInput];
      if (currentStatus && currentStatus.lastFullTimestamp) {
        const lastScanTime = new Date(currentStatus.lastFullTimestamp).getTime();
        const timeDiff = timestamp.getTime() - lastScanTime;
        
        if (timeDiff < 2000) {
          setLogs(prev => [...prev, {
            id: `rate-limit-${Date.now()}`,
            timestamp: new Date(),
            message: `[SYSTEM] Scan ignored: Minimum 2s interval required for user ${userInput}`,
            type: 'system'
          }]);
          return;
        }
      }

      // Determine status (logged in vs logged out)
      let nextStatus: 'logged in' | 'logged out' = 'logged in';

      if (currentStatus && currentStatus.lastDate === currentDate) {
        nextStatus = currentStatus.lastStatus === 'logged in' ? 'logged out' : 'logged in';
      }

      const username = uploadedUserMap[userInput] || `User_${userInput}`;

      try {
        // Update User Status in Firestore
        await setDoc(doc(db, 'terminals', user.uid, 'mappings', userInput), {
          username: userInput,
          displayName: username,
          lastStatus: nextStatus,
          lastTimestamp: formattedTime
        }, { merge: true });

        // Add Log Entry in Firestore
        await addDoc(collection(db, 'terminals', user.uid, 'logs'), {
          username: userInput,
          displayName: username,
          status: nextStatus,
          timestamp: formattedTime
        });

      } catch (error) {
        console.error("Firestore Error:", error);
        setLogs(prev => [...prev, {
          id: `err-${Date.now()}`,
          timestamp: new Date(),
          message: `[ERROR] Failed to save entry: ${error instanceof Error ? error.message : 'Unknown error'}`,
          type: 'system'
        }]);
      }
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: 'greedy',
        transformHeader: (header) => header.trim(),
        complete: (results) => {
          const newMap: UserMapping = {};
          results.data.forEach((row: any) => {
            // Clean up values
            const cleanRow: any = {};
            Object.keys(row).forEach(key => {
              cleanRow[key] = row[key]?.toString().trim();
            });

            // Priority: Fob Number > Tag ID > other ID fields
            const id = cleanRow["Fob Number"] || cleanRow["Tag ID"] || cleanRow.id || cleanRow.ID || cleanRow.number || cleanRow.Number || Object.values(cleanRow)[0];
            // Priority: Staff Name > other name fields
            const name = cleanRow["Staff Name"] || cleanRow.name || cleanRow.Name || cleanRow.username || cleanRow.Username || Object.values(cleanRow)[1];
            
            if (id && name && id !== "" && name !== "") {
              newMap[id] = name;
            }
          });
          setUploadedUserMap(newMap);
          alert(`Successfully imported ${Object.keys(newMap).length} user mappings.`);
        },
        error: (error) => {
          alert(`Error parsing CSV: ${error.message}`);
        }
      });
    }
  };

  const downloadTemplate = () => {
    const csvContent = "Fob Number,Tag ID,Staff Name\n123456789012,TAG_001,John Doe\n987654321098,TAG_002,Jane Smith";
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "user_template.csv");
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const exportLogsToCSV = async () => {
    if (!user) return;
    
    try {
      const q = query(collection(db, 'terminals', user.uid, 'logs'), orderBy('timestamp', 'desc'));
      const snapshot = await getDocs(q);
      
      const data = snapshot.docs.map(doc => {
        const d = doc.data();
        return {
          Username: d.username,
          DisplayName: d.displayName,
          Status: d.status,
          Timestamp: d.timestamp
        };
      });

      if (data.length === 0) {
        alert("No logs found to export.");
        return;
      }

      const csv = Papa.unparse(data);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.setAttribute("download", `terminal_logs_${format(new Date(), 'yyyy-MM-dd')}.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error("Export Error:", error);
      alert("Failed to export logs.");
    }
  };

  const connectGoogleDrive = async () => {
    if (!user) return;
    try {
      const response = await fetch(`/api/auth/google/url?login_hint=${encodeURIComponent(user.email || '')}`);
      const { url } = await response.json();
      
      // Pass userId in state so server knows who to associate the token with
      const authUrl = `${url}&state=${user.uid}`;
      
      window.open(authUrl, 'google_auth', 'width=600,height=700');
    } catch (error) {
      console.error("Auth URL Error:", error);
      alert("Failed to start Google Drive connection.");
    }
  };

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'GOOGLE_DRIVE_AUTH_SUCCESS') {
        alert("Google Drive connected successfully! Monthly auto-export is now active.");
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return (
    <div className="min-h-screen bg-black text-green-500 font-mono flex flex-col p-4 relative" onClick={handleTerminalClick}>
      {/* Header */}
      <div className="flex justify-between items-center mb-4 border-b border-green-900 pb-2">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <TerminalIcon size={20} />
            <span className="font-bold tracking-wider">CMD_TERMINAL_V1.0</span>
          </div>
          {user && (
            <div className="flex items-center gap-2 text-[10px] bg-green-900/20 px-2 py-1 rounded border border-green-900/50">
              <UserIcon size={12} />
              <span>{user.email}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!user ? (
            <button 
              onClick={(e) => { e.stopPropagation(); signIn(); }}
              className="flex items-center gap-2 px-3 py-1 bg-green-900 text-black text-[10px] font-bold hover:bg-green-400 transition-colors rounded"
            >
              <LogIn size={14} />
              SIGN_IN
            </button>
          ) : (
            <button 
              onClick={(e) => { e.stopPropagation(); signOut(); }}
              className="flex items-center gap-2 px-3 py-1 border border-green-900 text-green-700 text-[10px] hover:bg-green-900/20 transition-colors rounded"
            >
              <LogOut size={14} />
              SIGN_OUT
            </button>
          )}
          <button 
            onClick={(e) => {
              e.stopPropagation();
              setIsSettingsOpen(true);
            }}
            className="p-1 hover:bg-green-900/30 rounded transition-colors"
          >
            <Settings size={20} />
          </button>
        </div>
      </div>

      {/* Terminal Output */}
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto mb-4 space-y-1 scrollbar-thin"
      >
        {logs.map((log) => (
          <div 
            key={log.id} 
            className={cn(
              "break-all",
              log.type === 'input' && "text-white",
              log.type === 'system' && "text-blue-400 italic",
              log.type === 'output' && "text-green-400"
            )}
          >
            {log.message}
          </div>
        ))}
        
        {/* Input Line */}
        <div className="flex items-center gap-2">
          <ChevronRight size={18} className="text-white shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            className="bg-transparent border-none outline-none flex-1 text-white caret-green-500"
            autoFocus
          />
        </div>
      </div>

      {/* Footer Info */}
      <div className="text-[10px] text-green-900 flex justify-between">
        <span>STATUS: ONLINE</span>
        <span>{format(new Date(), 'yyyy-MM-dd HH:mm:ss')}</span>
      </div>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={(e) => e.stopPropagation()}>
          <div className="bg-[#111] border border-green-900 w-full max-w-md rounded-lg overflow-hidden flex flex-col shadow-2xl shadow-green-900/20">
            <div className="p-4 border-b border-green-900 flex justify-between items-center bg-green-900/10">
              <div className="flex items-center gap-2">
                <Settings size={18} />
                <h2 className="text-lg font-bold">SYSTEM_CONFIG</h2>
              </div>
              <button onClick={() => setIsSettingsOpen(false)} className="hover:text-white">
                <X size={20} />
              </button>
            </div>
            
            <div className="p-6 space-y-8 overflow-y-auto max-h-[70vh]">
              {/* Firebase Status Section */}
              <div className="space-y-3">
                <label className="text-sm font-semibold block text-green-400">FIREBASE_REALTIME_STATUS</label>
                <div className="bg-green-900/10 border border-green-900 p-4 rounded-lg space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-green-700">CONNECTION:</span>
                    <span className="text-green-400 font-bold">ONLINE</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-green-700">MODE:</span>
                    <span className="text-green-400 font-bold">REAL-TIME_SYNC</span>
                  </div>
                  <p className="text-[10px] text-green-800 italic mt-2">
                    All sign-ins are instantly synced to Firestore and visible across all connected terminals.
                  </p>
                </div>
              </div>

              {/* CSV Import Section */}
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <label className="text-sm font-semibold block text-green-400">USER_MAPPING_IMPORT (.CSV)</label>
                  <button 
                    onClick={downloadTemplate}
                    className="text-[10px] text-blue-400 hover:underline flex items-center gap-1"
                  >
                    DOWNLOAD_TEMPLATE
                  </button>
                </div>
                
                <div className="space-y-3">
                  <label className="flex items-center justify-center gap-2 border border-dashed border-green-800 p-6 rounded-lg cursor-pointer hover:bg-green-900/10 transition-colors group">
                    <Upload size={20} className="group-hover:scale-110 transition-transform" />
                    <div className="text-center">
                      <span className="text-xs block font-bold">CHOOSE_CSV_FILE</span>
                      <span className="text-[9px] text-green-800">Fob Number, Tag ID, Staff Name</span>
                    </div>
                    <input type="file" accept=".csv" onChange={handleFileUpload} className="hidden" />
                  </label>
                  
                  <div className="flex justify-between items-center bg-black/40 p-2 rounded border border-green-900/30">
                    <span className="text-[10px] text-green-700">ACTIVE_MAPPINGS:</span>
                    <span className="text-[10px] text-green-400 font-mono">{Object.keys(uploadedUserMap).length}</span>
                  </div>
                </div>
              </div>

              {/* Data Export Section */}
              <div className="space-y-3">
                <label className="text-sm font-semibold block text-green-400">DATA_EXPORT</label>
                <button 
                  onClick={exportLogsToCSV}
                  className="w-full flex items-center justify-center gap-2 bg-blue-900/20 border border-blue-900 text-blue-400 p-4 rounded-lg hover:bg-blue-900/40 transition-colors font-bold text-xs"
                >
                  <Download size={18} />
                  EXPORT_ALL_LOGS_TO_CSV
                </button>
                <p className="text-[10px] text-blue-900 italic">
                  This will download a complete history of all sign-in/out events from the database.
                </p>
              </div>

              {/* Google Drive Automation Section */}
              <div className="space-y-3">
                <label className="text-sm font-semibold block text-green-400">AUTOMATION (GOOGLE_DRIVE)</label>
                <div className="bg-green-900/10 border border-green-900 p-4 rounded-lg space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-green-700">STATUS:</span>
                    <span className={cn(
                      "text-xs font-bold",
                      isDriveConnected ? "text-green-400" : "text-red-400"
                    )}>
                      {isDriveConnected ? "CONNECTED" : "NOT_CONNECTED"}
                    </span>
                  </div>
                  
                  {!isDriveConnected ? (
                    <button 
                      onClick={connectGoogleDrive}
                      className="w-full bg-white text-black py-2 rounded text-xs font-bold hover:bg-gray-200 transition-colors flex items-center justify-center gap-2"
                    >
                      <LinkIcon size={14} />
                      CONNECT_GOOGLE_DRIVE
                    </button>
                  ) : (
                    <div className="text-[10px] text-green-400 bg-green-900/20 p-2 rounded border border-green-900/30 text-center">
                      ✓ Monthly auto-export is ACTIVE
                    </div>
                  )}
                  
                  <p className="text-[9px] text-green-800 italic">
                    When connected, logs will be automatically exported to your Google Drive on the last day of every month, and the database will be cleared.
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 bg-green-900/5 border-t border-green-900 flex justify-end">
              <button 
                onClick={() => setIsSettingsOpen(false)}
                className="bg-green-400 text-black px-6 py-2 text-xs font-bold hover:bg-green-300 transition-colors"
              >
                SAVE_AND_CLOSE
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
