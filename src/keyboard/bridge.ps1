$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KeyboardBridge {
  private const int WH_KEYBOARD_LL = 13;
  private const int WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
  private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
  private static HookProc callback = Handle;
  private static IntPtr hook;
  [StructLayout(LayoutKind.Sequential)] private struct Kbd { public uint vkCode, scanCode, flags, time; public IntPtr extraInfo; }
  [StructLayout(LayoutKind.Sequential)] private struct Msg { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; public uint privateData; }
  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
  [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] private static extern int GetMessage(out Msg msg, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Msg msg);
  [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Msg msg);
  private static IntPtr Handle(int code, IntPtr wParam, IntPtr lParam) {
    if (code >= 0) {
      int message = wParam.ToInt32();
      if (message == WM_KEYDOWN || message == WM_SYSKEYDOWN || message == WM_KEYUP || message == WM_SYSKEYUP) {
        var key = (Kbd)Marshal.PtrToStructure(lParam, typeof(Kbd));
        Console.WriteLine("{\"event\":\"" + ((message == WM_KEYDOWN || message == WM_SYSKEYDOWN) ? "down" : "up") + "\",\"vk\":" + key.vkCode + ",\"scan\":" + key.scanCode + ",\"flags\":" + key.flags + "}");
      }
    }
    return CallNextHookEx(hook, code, wParam, lParam);
  }
  public static void Run() {
    hook = SetWindowsHookEx(WH_KEYBOARD_LL, callback, IntPtr.Zero, 0);
    if (hook == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try { Msg msg; while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessage(ref msg); } }
    finally { UnhookWindowsHookEx(hook); }
  }
}
'@
[KeyboardBridge]::Run()
