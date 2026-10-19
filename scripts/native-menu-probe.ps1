param([int]$AppProcessId, [int]$Select = -1)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class CaptionMenuProbe {
 public delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback,IntPtr p);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint id);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h,int message,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetMenuString(IntPtr menu,uint index,StringBuilder s,int max,uint flags);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool GetMenuItemRect(IntPtr hwnd,IntPtr menu,uint index,out RECT rect);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern uint SendInput(uint count,INPUT[] inputs,int size);
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
 [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public KEYBOARD keyboard; [FieldOffset(0)] public MOUSE mouse; }
 [StructLayout(LayoutKind.Sequential)] public struct KEYBOARD { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSE { public int x,y;public uint mouseData,flags,time;public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct RECT {public int left,top,right,bottom;}
 static IntPtr popup;
 public static string[] Read(int pid) {
  IntPtr menu=IntPtr.Zero;
  EnumWindows((h,p)=>{ uint id;GetWindowThreadProcessId(h,out id);if(id!=(uint)pid)return true;
   var name=new StringBuilder(64);GetClassName(h,name,64);if(name.ToString()=="#32768"){menu=SendMessage(h,0x1E1,IntPtr.Zero,IntPtr.Zero);return false;}return true;
  },IntPtr.Zero);
  if(menu==IntPtr.Zero)throw new Exception("Native popup not found for isolated test application");
  popup=menu;
  var items=new List<string>();for(uint i=0;i<GetMenuItemCount(menu);i++){var s=new StringBuilder(256);GetMenuString(menu,i,s,256,0x400);if(s.Length>0)items.Add(s.ToString());}
  return items.ToArray();
 }
 public static void Choose(int pid,int index) {
  uint active;GetWindowThreadProcessId(GetForegroundWindow(),out active);if(active!=(uint)pid)throw new Exception("Test application is not foreground; refusing input");
  int logical=0;for(uint i=0;i<GetMenuItemCount(popup);i++){
   var label=new StringBuilder(256);GetMenuString(popup,i,label,256,0x400);if(label.Length==0)continue;
   if(logical++!=index)continue;
   RECT rect;if(!GetMenuItemRect(IntPtr.Zero,popup,i,out rect))throw new Exception("Cannot locate native menu item");
   SetCursorPos((rect.left+rect.right)/2,(rect.top+rect.bottom)/2);
   var inputs=new[]{new INPUT{type=0,data=new UNION{mouse=new MOUSE{flags=2}}},new INPUT{type=0,data=new UNION{mouse=new MOUSE{flags=4}}}};
   if(SendInput(2,inputs,Marshal.SizeOf<INPUT>())!=2)throw new Exception("Failed native menu click");return;
  }
  throw new Exception("Native menu index is out of range");
 }
}
'@
$items = [CaptionMenuProbe]::Read($AppProcessId)
ConvertTo-Json -InputObject @($items) -Compress
if ($Select -ge 0) { [CaptionMenuProbe]::Choose($AppProcessId, $Select) }
