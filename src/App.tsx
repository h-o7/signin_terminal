import React, { useState, useEffect, useRef } from 'react';
import { Settings, X, Upload, Link as LinkIcon, Terminal as TerminalIcon, ChevronRight } from 'lucide-react';
import Papa from 'papaparse';
import { format } from 'date-fns';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

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
}

interface UserStatusMap {
  [key: string]: UserStatus;
}

export default function App() {
  console.log("[SYSTEM] APP_COMPONENT_MOUNTING");
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
  const [dataSource, setDataSource] = useState<'upload' | 'google_sheet'>(() => {
    try {
      return (localStorage.getItem('terminal_data_source') as 'upload' | 'google_sheet') || 'upload';
    } catch (e) {
      return 'upload';
    }
  });
  const [uploadedUserMap, setUploadedUserMap] = useState<UserMapping>(() => {
    try {
      const saved = localStorage.getItem('terminal_user_map');
      return saved ? JSON.parse(saved) : {};
    } catch (e) {
      return {};
    }
  });
  const [remoteUserMap, setRemoteUserMap] = useState<UserMapping>(() => {
    try {
      const saved = localStorage.getItem('terminal_remote_user_map');
      return saved ? JSON.parse(saved) : {};
    } catch (e) {
      return {};
    }
  });
  const [googleSheetCsvUrl, setGoogleSheetCsvUrl] = useState(() => {
    try {
      return localStorage.getItem('terminal_gsheet_csv_url') || '';
    } catch (e) {
      return '';
    }
  });
  const [spreadsheetUrl, setSpreadsheetUrl] = useState(() => {
    try {
      return localStorage.getItem('terminal_sheet_url') || '';
    } catch (e) {
      return '';
    }
  });
  const [webhookUrl, setWebhookUrl] = useState(() => {
    try {
      return localStorage.getItem('terminal_webhook_url') || '';
    } catch (e) {
      return '';
    }
  });
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'sent' | 'error'>('idle');
  const [lastSyncResult, setLastSyncResult] = useState<string | null>(null);
  const [queueSize, setQueueSize] = useState(0);
  const [secondsUntilFlush, setSecondsUntilFlush] = useState(60);
  const pendingLogsRef = useRef<{username: string, timestamp: string, status: string}[]>([]);
  const [userStatuses, setUserStatuses] = useState<UserStatusMap>(() => {
    try {
      const saved = localStorage.getItem('terminal_user_statuses');
      return saved ? JSON.parse(saved) : {};
    } catch (e) {
      return {};
    }
  });
  
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
      localStorage.setItem('terminal_remote_user_map', JSON.stringify(remoteUserMap));
    } catch (e) {}
  }, [remoteUserMap]);

  useEffect(() => {
    try {
      localStorage.setItem('terminal_data_source', dataSource);
    } catch (e) {}
  }, [dataSource]);

  useEffect(() => {
    try {
      localStorage.setItem('terminal_gsheet_csv_url', googleSheetCsvUrl);
    } catch (e) {}
  }, [googleSheetCsvUrl]);

  useEffect(() => {
    try {
      localStorage.setItem('terminal_sheet_url', spreadsheetUrl);
    } catch (e) {}
  }, [spreadsheetUrl]);

  useEffect(() => {
    try {
      localStorage.setItem('terminal_webhook_url', webhookUrl);
    } catch (e) {}
  }, [webhookUrl]);

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

  const flushLogs = async () => {
    if (pendingLogsRef.current.length === 0 || !webhookUrl) {
      setSecondsUntilFlush(60);
      return;
    }
    
    const logsToSend = [...pendingLogsRef.current];
    pendingLogsRef.current = [];
    setQueueSize(0);
    setSecondsUntilFlush(60);
    
    setLastSyncResult(`PUSHING ${logsToSend.length} ENTRIES...`);
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          logs: logsToSend,
          spreadsheetUrl,
        }),
      });
      setLastSyncResult(`SUCCESS (${logsToSend.length} ENTRIES PUSHED)`);
    } catch (error) {
      console.error('Failed to flush logs:', error);
      setLastSyncResult(`FAILED: ${error instanceof Error ? error.message : 'Unknown Error'}`);
      // If it failed, we could potentially put them back, but for now we'll just log the error
    }
  };

  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsUntilFlush(prev => {
        if (prev <= 1) {
          flushLogs();
          return 60;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [webhookUrl, spreadsheetUrl]);

  const queueLog = (username: string, time: string, status: string) => {
    if (!webhookUrl) {
      setLogs(prev => [...prev, {
        id: Math.random().toString(36).substr(2, 9),
        timestamp: new Date(),
        message: `Warning: LOGGING_WEBHOOK not configured. Entry for ${username} not saved.`,
        type: 'system'
      }]);
      return;
    }
    
    pendingLogsRef.current.push({ username, timestamp: time, status });
    setQueueSize(pendingLogsRef.current.length);
  };

  const copyScriptToClipboard = () => {
    const script = `function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(10000);
  
  try {
    var contents = e.postData.contents;
    var data = JSON.parse(contents);
    var ss = data.spreadsheetUrl ? SpreadsheetApp.openByUrl(data.spreadsheetUrl) : SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheets()[0];
    
    // Handle both single entry and batch (array)
    var logs = data.logs || [data];
    
    logs.forEach(function(log) {
      sheet.appendRow([
        log.timestamp || new Date().toLocaleString(),
        log.username || "Unknown User",
        log.status || "No Status"
      ]);
    });
    
    return ContentService.createTextOutput("Success").setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    console.error(err.message);
    return ContentService.createTextOutput("Error: " + err.message).setMimeType(ContentService.MimeType.TEXT);
  } finally {
    lock.releaseLock();
  }
}`;
    navigator.clipboard.writeText(script);
    alert("Batch-ready script copied to clipboard! Update your Google Apps Script and re-deploy.");
  };

  const testWebhook = async () => {
    if (!webhookUrl || !spreadsheetUrl) {
      alert("Please configure both SPREADSHEET_LINK and LOGGING_WEBHOOK first.");
      return;
    }

    setTestStatus('testing');
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: "SYSTEM_TEST_USER",
          timestamp: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
          status: "test_signal",
          spreadsheetUrl,
        }),
      });
      setTestStatus('sent');
      setTimeout(() => setTestStatus('idle'), 5000);
    } catch (error) {
      setTestStatus('error');
      setTimeout(() => setTestStatus('idle'), 5000);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && input.length > 0) {
      const timestamp = new Date();
      const formattedTime = format(timestamp, 'yyyy-MM-dd HH:mm:ss');
      const currentDate = format(timestamp, 'yyyy-MM-dd');
      
      // Add input log
      const newLogs: LogEntry[] = [
        ...logs,
        {
          id: Math.random().toString(36).substr(2, 9),
          timestamp,
          message: `> ${input}`,
          type: 'input',
        },
      ];

      // Determine status (logged in vs logged out)
      const userStatus = userStatuses[input];
      let nextStatus: 'logged in' | 'logged out' = 'logged in';

      if (userStatus && userStatus.lastDate === currentDate) {
        // Toggle if same day
        nextStatus = userStatus.lastStatus === 'logged in' ? 'logged out' : 'logged in';
      } else {
        // First time today, always 'logged in'
        nextStatus = 'logged in';
      }

      // Update status map
      setUserStatuses(prev => ({
        ...prev,
        [input]: {
          lastStatus: nextStatus,
          lastDate: currentDate
        }
      }));

      // Process output
      const username = userMap[input] || `User_${input}`;
      const outputMessage = `${username} ${nextStatus} at ${formattedTime}`;
      
      newLogs.push({
        id: Math.random().toString(36).substr(2, 9),
        timestamp,
        message: outputMessage,
        type: 'output',
      });

      setLogs(newLogs);
      setInput('');
      
      // Log to spreadsheet (Queued for 60s batch)
      queueLog(username, formattedTime, nextStatus);
    }
  };

  const userMap = dataSource === 'upload' ? uploadedUserMap : remoteUserMap;

  const fetchRemoteData = async () => {
    if (!googleSheetCsvUrl) return;
    
    let targetUrl = googleSheetCsvUrl;
    
    // Transform standard Google Sheets URL to CSV export URL if needed
    if (targetUrl.includes('docs.google.com/spreadsheets/d/')) {
      const match = targetUrl.match(/\/d\/([^\/]+)/);
      if (match && match[1]) {
        const spreadsheetId = match[1];
        // Extract gid if present
        const gidMatch = targetUrl.match(/[#&]gid=([0-9]+)/);
        const gid = gidMatch ? gidMatch[1] : '0';
        targetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
      }
    }
    
    try {
      // On static hosts like GitHub Pages, we must fetch directly because there is no backend proxy.
      // Google Sheets CSV export supports CORS if the sheet is "Published to the web".
      const isStaticHost = window.location.hostname.includes('github.io');
      const proxyUrl = isStaticHost ? targetUrl : `/api/proxy-csv?url=${encodeURIComponent(targetUrl)}`;
      
      const response = await fetch(proxyUrl);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const csvText = await response.text();
      
      // Check if we actually got HTML instead of CSV (common if not published or wrong URL)
      if (csvText.trim().startsWith('<!DOCTYPE html>') || csvText.trim().startsWith('<html')) {
        throw new Error("Received HTML instead of CSV. Please ensure your Google Sheet is 'Published to the web' as a CSV.");
      }
      
      Papa.parse(csvText, {
        header: true,
        skipEmptyLines: 'greedy', // Better at skipping rows with just commas
        transformHeader: (header) => header.trim(), // Normalize headers
        complete: (results) => {
          const newMap: UserMapping = {};
          let skippedCount = 0;
          
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
            } else {
              skippedCount++;
            }
          });

          setRemoteUserMap(newMap);
          
          const totalFound = Object.keys(newMap).length;
          const headersFound = results.meta.fields?.join(', ') || 'none';
          
          setLogs(prev => [...prev, {
            id: Math.random().toString(36).substr(2, 9),
            timestamp: new Date(),
            message: `Sync complete: ${totalFound} users loaded. (Skipped ${skippedCount} invalid rows). Headers detected: [${headersFound}]`,
            type: 'system'
          }]);
        }
      });
    } catch (error) {
      console.error('Failed to fetch remote CSV:', error);
      setLogs(prev => [...prev, {
        id: Math.random().toString(36).substr(2, 9),
        timestamp: new Date(),
        message: `Error: Failed to sync remote user list. Check your URL and "Publish to Web" settings.`,
        type: 'system'
      }]);
    }
  };

  useEffect(() => {
    if (dataSource === 'google_sheet') {
      fetchRemoteData();
    }
  }, [dataSource, googleSheetCsvUrl]);

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

  return (
    <div className="min-h-screen bg-black text-green-500 font-mono flex flex-col p-4 relative" onClick={handleTerminalClick}>
      {/* Header */}
      <div className="flex justify-between items-center mb-4 border-b border-green-900 pb-2">
        <div className="flex items-center gap-2">
          <TerminalIcon size={20} />
          <span className="font-bold tracking-wider">CMD_TERMINAL_V1.0</span>
        </div>
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
            
            <div className="p-6 space-y-6 overflow-y-auto max-h-[70vh]">
              {/* Data Source Selection */}
              <div className="space-y-3">
                <label className="text-sm font-semibold block text-green-400">USER_DATA_SOURCE</label>
                <div className="grid grid-cols-2 gap-2">
                  <button 
                    onClick={() => setDataSource('upload')}
                    className={cn(
                      "p-2 text-xs border transition-colors",
                      dataSource === 'upload' ? "bg-green-900 border-green-400 text-black font-bold" : "border-green-900 text-green-700"
                    )}
                  >
                    UPLOADED_CSV
                  </button>
                  <button 
                    onClick={() => setDataSource('google_sheet')}
                    className={cn(
                      "p-2 text-xs border transition-colors",
                      dataSource === 'google_sheet' ? "bg-green-900 border-green-400 text-black font-bold" : "border-green-900 text-green-700"
                    )}
                  >
                    GOOGLE_SHEET_CSV
                  </button>
                </div>
              </div>

              {/* CSV Import (Conditional) */}
              {dataSource === 'upload' ? (
                <div className="space-y-3 animate-in fade-in duration-300">
                  <div className="flex justify-between items-center">
                    <label className="text-sm font-semibold block text-green-400">USER_DATA_IMPORT (.CSV)</label>
                    <button 
                      onClick={downloadTemplate}
                      className="text-[10px] text-blue-400 hover:underline flex items-center gap-1"
                    >
                      DOWNLOAD_TEMPLATE
                    </button>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex-1 flex items-center justify-center gap-2 border border-dashed border-green-800 p-4 rounded cursor-pointer hover:bg-green-900/10 transition-colors">
                      <Upload size={18} />
                      <span className="text-xs">CHOOSE FILE</span>
                      <input type="file" accept=".csv" onChange={handleFileUpload} className="hidden" />
                    </label>
                  </div>
                  <p className="text-[10px] text-green-700">Columns: Fob Number, Tag ID, Staff Name</p>
                  <p className="text-[10px] text-green-800 italic">Current Mappings: {Object.keys(uploadedUserMap).length}</p>
                </div>
              ) : (
                <div className="space-y-3 animate-in fade-in duration-300">
                  <label className="text-sm font-semibold block text-green-400">REMOTE_CSV_URL (PUBLISHED_SHEET)</label>
                  <div className="flex items-center gap-2 bg-black border border-green-900 p-2 rounded">
                    <LinkIcon size={16} className="text-green-800" />
                    <input 
                      type="text" 
                      value={googleSheetCsvUrl}
                      onChange={(e) => setGoogleSheetCsvUrl(e.target.value)}
                      placeholder="https://docs.google.com/spreadsheets/d/.../export?format=csv"
                      className="bg-transparent border-none outline-none flex-1 text-xs text-green-200"
                    />
                  </div>
                  <button 
                    onClick={fetchRemoteData}
                    className="w-full bg-green-900/20 border border-green-900 py-2 text-[10px] hover:bg-green-900/40 transition-colors"
                  >
                    SYNC_NOW
                  </button>
                  <p className="text-[10px] text-green-700">Make sure your sheet is "Published to web" as a CSV.</p>
                  <p className="text-[10px] text-green-800 italic">Current Mappings: {Object.keys(remoteUserMap).length}</p>
                </div>
              )}

              {/* Spreadsheet URL */}
              <div className="space-y-3">
                <label className="text-sm font-semibold block text-green-400">SPREADSHEET_LINK</label>
                <div className="flex items-center gap-2 bg-black border border-green-900 p-2 rounded">
                  <LinkIcon size={16} className="text-green-800" />
                  <input 
                    type="text" 
                    value={spreadsheetUrl}
                    onChange={(e) => setSpreadsheetUrl(e.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/d/..."
                    className="bg-transparent border-none outline-none flex-1 text-xs text-green-200"
                  />
                </div>
                {spreadsheetUrl && (
                  <a 
                    href={spreadsheetUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-[10px] text-blue-500 hover:underline flex items-center gap-1"
                  >
                    OPEN_SPREADSHEET <ChevronRight size={10} />
                  </a>
                )}
              </div>

              {/* Webhook Configuration */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <label className="text-sm font-semibold block text-green-400">LOGGING_WEBHOOK (OPTIONAL)</label>
                  <div className="flex gap-2">
                    <button 
                      onClick={copyScriptToClipboard}
                      className="text-[10px] px-2 py-1 border border-green-900 text-green-700 hover:bg-green-900/20 transition-colors"
                    >
                      COPY_SCRIPT
                    </button>
                    <button 
                      onClick={testWebhook}
                      disabled={testStatus === 'testing'}
                      className={cn(
                        "text-[10px] px-2 py-1 border transition-colors",
                        testStatus === 'idle' && "text-blue-400 border-blue-900 hover:bg-blue-900/20",
                        testStatus === 'testing' && "text-yellow-400 border-yellow-900 animate-pulse",
                        testStatus === 'sent' && "text-green-400 border-green-900",
                        testStatus === 'error' && "text-red-400 border-red-900"
                      )}
                    >
                      {testStatus === 'idle' && "TEST_CONNECTION"}
                      {testStatus === 'testing' && "SENDING..."}
                      {testStatus === 'sent' && "SIGNAL_SENT!"}
                      {testStatus === 'error' && "FAILED"}
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2 bg-black border border-green-900 p-2 rounded">
                  <TerminalIcon size={16} className="text-green-800" />
                  <input 
                    type="text" 
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    placeholder="Google Apps Script Webhook URL"
                    className="bg-transparent border-none outline-none flex-1 text-xs text-green-200"
                  />
                </div>
                <div className="flex justify-between items-center">
                  <p className="text-[10px] text-green-700">Batching updates every 60s. Queue: {queueSize} | Next push in {secondsUntilFlush}s</p>
                  {lastSyncResult && (
                    <span className={cn(
                      "text-[9px] font-bold",
                      lastSyncResult.includes('SUCCESS') ? "text-green-500" : "text-red-500"
                    )}>
                      LAST_SYNC: {lastSyncResult}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button 
                    onClick={flushLogs}
                    disabled={queueSize === 0}
                    className="text-[9px] px-2 py-1 border border-blue-900 text-blue-400 hover:bg-blue-900/20 disabled:opacity-30"
                  >
                    PUSH_NOW
                  </button>
                </div>
                {testStatus === 'sent' && (
                  <p className="text-[10px] text-green-400 italic">Check your spreadsheet for a "SYSTEM_TEST_USER" entry.</p>
                )}
              </div>
            </div>

            <div className="p-4 bg-green-900/5 border-t border-green-900 flex justify-end">
              <button 
                onClick={() => setIsSettingsOpen(false)}
                className="bg-green-900 text-black px-6 py-2 text-xs font-bold hover:bg-green-400 transition-colors"
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
