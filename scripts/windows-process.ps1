param([Parameter(Mandatory=$true)][int]$TargetProcessId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class WerewolfProcessDirectory {
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr read);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, ref PROCESS_BASIC_INFORMATION info, int size, out int returned);
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_BASIC_INFORMATION { public IntPtr Reserved1; public IntPtr Peb; public IntPtr Reserved2a; public IntPtr Reserved2b; public IntPtr ProcessId; public IntPtr Reserved3; }
    static byte[] Read(IntPtr process, long address, int size) { var b = new byte[size]; IntPtr n; if (!ReadProcessMemory(process, new IntPtr(address), b, size, out n) || n.ToInt64() != size) throw new Win32Exception(Marshal.GetLastWin32Error()); return b; }
    public static string Get(int pid) {
        if (IntPtr.Size != 8) throw new Exception("64-bit PowerShell required");
        IntPtr h = OpenProcess(0x410, false, pid); if (h == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var p = new PROCESS_BASIC_INFORMATION(); int count;
            if (NtQueryInformationProcess(h, 0, ref p, Marshal.SizeOf(p), out count) != 0) throw new Exception("Cannot query process");
            long parameters = BitConverter.ToInt64(Read(h, p.Peb.ToInt64() + 0x20, 8), 0);
            byte[] unicode = Read(h, parameters + 0x38, 16); int length = BitConverter.ToUInt16(unicode, 0); long buffer = BitConverter.ToInt64(unicode, 8);
            if (length < 2 || length > 32766 || length % 2 != 0 || buffer == 0) throw new Exception("Invalid process directory");
            return Encoding.Unicode.GetString(Read(h, buffer, length));
        } finally { CloseHandle(h); }
    }
}
'@
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetProcessId"
if ($null -eq $p) { throw 'Process not found' }
@{ pid = [int]$p.ProcessId; commandLine = [string]$p.CommandLine; startedAt = $p.CreationDate.ToUniversalTime().ToString('o'); cwd = [WerewolfProcessDirectory]::Get($TargetProcessId) } | ConvertTo-Json -Compress
