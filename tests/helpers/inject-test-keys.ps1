$ErrorActionPreference = 'Stop'
# Only unused function keys: do not invoke Copilot or type into the active app.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TestKeys {
  [StructLayout(LayoutKind.Sequential)] private struct Keyboard {
    public ushort vk, scan; public uint flags, time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)] private struct Mouse {
    public int x, y; public uint data, flags, time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Explicit)] private struct InputData {
    [FieldOffset(0)] public Keyboard keyboard;
    [FieldOffset(0)] public Mouse mouse;
  }
  [StructLayout(LayoutKind.Sequential)] private struct Input { public uint type; public InputData data; }
  [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Input[] inputs, int size);
  public static void Send() {
    var inputs = new Input[4];
    for (int index = 0; index < inputs.Length; index++) {
      inputs[index].type = 1;
      inputs[index].data.keyboard.vk = (ushort)(index < 2 ? 135 : 133); // F24, F22
      inputs[index].data.keyboard.flags = (uint)(index % 2 == 1 ? 2 : 0);
    }
    if (SendInput(4, inputs, Marshal.SizeOf(typeof(Input))) != 4)
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
[TestKeys]::Send()
