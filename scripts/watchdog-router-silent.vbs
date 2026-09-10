' watchdog-router-silent.vbs - run watchdog-router.ps1 with no console window
' (scheduled task triggers this every 5 min; a direct powershell.exe action
'  flashes a console window on the desktop each run)
Set ws = CreateObject("WScript.Shell")
ps1 = Replace(WScript.ScriptFullName, "watchdog-router-silent.vbs", "watchdog-router.ps1")
ws.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
