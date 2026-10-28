# CI only: model an ordinary user's default file owner without changing machine policy.
# Elevated hosted runners default to Administrators; child fixtures need TokenOwner=TokenUser.
param([Parameter(Mandatory=$true)][string[]]$TestFiles)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class CrabotFixtureOwner {
  [StructLayout(LayoutKind.Sequential)] struct Owner { public IntPtr Sid; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr value);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr token, int kind, ref Owner value, int length);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr value, int length, out int required);
  public static void Apply() {
    var user = WindowsIdentity.GetCurrent().User;
    byte[] bytes = new byte[user.BinaryLength]; user.GetBinaryForm(bytes, 0);
    IntPtr sid = Marshal.AllocHGlobal(bytes.Length), token = IntPtr.Zero, observed = IntPtr.Zero;
    try {
      Marshal.Copy(bytes, 0, sid, bytes.Length);
      if (!OpenProcessToken(GetCurrentProcess(), 0x80 | 0x8, out token)) throw new Win32Exception();
      var owner = new Owner { Sid = sid };
      if (!SetTokenInformation(token, 4, ref owner, Marshal.SizeOf(typeof(Owner)))) throw new Win32Exception();
      int size; GetTokenInformation(token, 4, IntPtr.Zero, 0, out size);
      if (size <= 0 || size > 65536) throw new Exception("Fixture token owner unavailable");
      observed = Marshal.AllocHGlobal(size);
      if (!GetTokenInformation(token, 4, observed, size, out size)) throw new Win32Exception();
      if (!new SecurityIdentifier(Marshal.ReadIntPtr(observed)).Equals(user)) throw new Exception("Fixture token owner mismatch");
    } finally {
      if (observed != IntPtr.Zero) Marshal.FreeHGlobal(observed);
      if (token != IntPtr.Zero) CloseHandle(token);
      Marshal.FreeHGlobal(sid);
    }
  }
}
'@
[CrabotFixtureOwner]::Apply()
& node --test --test-concurrency=1 @TestFiles
exit $LASTEXITCODE
