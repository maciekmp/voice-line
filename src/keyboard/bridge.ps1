param(
  [ValidateRange(0, 255)][int]$SuppressVk = 0,
  [ValidateRange(0, 2147483647)][int]$ParentPid = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class KeyboardBridge {
  private const int WH_KEYBOARD_LL = 13;
  private const int WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
  private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
  private static HookProc callback = Handle;
  private static IntPtr hook;
  private static uint suppressedVk;
  [StructLayout(LayoutKind.Sequential)] private struct Kbd { public uint vkCode, scanCode, flags, time; public IntPtr extraInfo; }
  [StructLayout(LayoutKind.Sequential)] private struct Msg { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; public uint privateData; }
  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
  [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] private static extern int GetMessage(out Msg msg, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] private static extern bool PeekMessage(out Msg msg, IntPtr hwnd, uint min, uint max, uint remove);
  [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint thread, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Msg msg);
  [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Msg msg);
  private static IntPtr Handle(int code, IntPtr wParam, IntPtr lParam) {
    if (code >= 0) {
      int message = wParam.ToInt32();
      if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN || message == WM_KEYUP || message == WM_SYSKEYUP) {
        var key = (Kbd)Marshal.PtrToStructure(lParam, typeof(Kbd));
        Console.WriteLine("{\"event\":\"" + ((message == WM_KEYDOWN || message == WM_SYSKEYDOWN) ? "down" : "up") + "\",\"vk\":" + key.vkCode + ",\"scan\":" + key.scanCode + ",\"flags\":" + key.flags + "}");
        // Deliver to Voice Line, then consume both press and release before
        // Windows or a later hook can trigger the configured key's action.
        if (suppressedVk != 0 && key.vkCode == suppressedVk) return new IntPtr(1);
      }
    }
    return CallNextHookEx(hook, code, wParam, lParam);
  }
  public static void Run(int suppressVk, int parentPid) {
    suppressedVk = (uint)suppressVk;
    Msg queued;
    PeekMessage(out queued, IntPtr.Zero, 0, 0, 0); // Create the thread's message queue.
    uint threadId = GetCurrentThreadId();
    hook = SetWindowsHookEx(WH_KEYBOARD_LL, callback, IntPtr.Zero, 0);
    if (hook == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      if (parentPid > 0) {
        var watcher = new Thread(() => {
          try { using (var parent = Process.GetProcessById(parentPid)) parent.WaitForExit(); }
          catch (ArgumentException) { } // Parent already exited during startup.
          finally { PostThreadMessage(threadId, 0x12, IntPtr.Zero, IntPtr.Zero); } // WM_QUIT
        });
        watcher.IsBackground = true;
        watcher.Start();
      }
      Console.WriteLine("{\"type\":\"ready\"}");
      Msg msg;
      int result;
      while ((result = GetMessage(out msg, IntPtr.Zero, 0, 0)) > 0) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
      if (result == -1) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    finally { UnhookWindowsHookEx(hook); }
  }
}
'@
[KeyboardBridge]::Run($SuppressVk, $ParentPid)
