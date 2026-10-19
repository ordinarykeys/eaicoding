// Adapted from DeepSeek Harness, MIT. See THIRD_PARTY_NOTICES.md.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define UNICODE
#include <windows.h>
#include <objidl.h>
#include <commctrl.h>
#include <dwmapi.h>
#include <gdiplus.h>
#include <new>
#include "progress.h"
#include "extract.h"
using namespace Gdiplus;
struct ProgressPage {
    InstallProgress progress{GetTickCount64()};
    bool dark;
    UINT dpi;
    ULONG_PTR gdiplus;
    Image* brand;
    Bitmap* canvas = nullptr;
    WCHAR captions[6][128];
    WCHAR lastCaption[160] = {};
    bool runtime = false;
};

// NSIS shows its page after MUI's SHOW callback; keep its controls off screen.
static LRESULT CALLBACK HiddenPageProc(HWND window, UINT message, WPARAM wparam,
                                      LPARAM lparam, UINT_PTR id, DWORD_PTR) {
    if (message == WM_WINDOWPOSCHANGING) {
        auto* position = reinterpret_cast<WINDOWPOS*>(lparam);
        position->flags = (position->flags & ~SWP_SHOWWINDOW) | SWP_HIDEWINDOW;
    }
    if (message == WM_NCDESTROY) RemoveWindowSubclass(window, HiddenPageProc, id);
    return DefSubclassProc(window, message, wparam, lparam);
}

static void FillProgress(Graphics& graphics, Brush& brush, REAL width) {
    if (width <= 0) return;
    if (width < 4) { graphics.FillRectangle(&brush, 64.0f, 482.0f, width, 6.0f); return; }
    GraphicsPath path;
    path.AddArc(64.0f, 482.0f, 4.0f, 4.0f, 180.0f, 90.0f);
    path.AddArc(64.0f + width - 4, 482.0f, 4.0f, 4.0f, 270.0f, 90.0f);
    path.AddArc(64.0f + width - 4, 484.0f, 4.0f, 4.0f, 0.0f, 90.0f);
    path.AddArc(64.0f, 484.0f, 4.0f, 4.0f, 90.0f, 90.0f);
    path.CloseFigure();
    graphics.FillPath(&brush, &path);
}

static LRESULT CALLBACK ProgressProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    auto* page = reinterpret_cast<ProgressPage*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_CREATE) {
        page = static_cast<ProgressPage*>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(page));
        SetTimer(window, 1, 16, nullptr);
    }
    if (message == WM_ERASEBKGND) return 1;
    if (message == WM_TIMER && page) {
        const HWND parent = GetParent(window);
        const int stage = static_cast<int>(reinterpret_cast<INT_PTR>(GetPropW(parent, L"EAiCodingInstaller.Stage")));
        const double fraction = reinterpret_cast<UINT_PTR>(GetPropW(parent, L"EAiCodingInstaller.ExtractProgress")) / 100.0;
        page->runtime = GetPropW(parent, L"EAiCodingInstaller.Runtime") != nullptr;
        page->progress.Advance(stage, fraction, GetTickCount64());
        if (!IsIconic(parent)) {
            RECT area{MulDiv(48, page->dpi, 96), MulDiv(480, page->dpi, 96), MulDiv(552, page->dpi, 96), MulDiv(542, page->dpi, 96)};
            InvalidateRect(window, &area, FALSE);
        }
        return 0;
    }
    if (message == WM_LBUTTONDOWN && page) {
        const int x = LOWORD(lparam) * 96 / page->dpi;
        const int y = HIWORD(lparam) * 96 / page->dpi;
        if (y < 48) {
            HWND parent = GetParent(window);
            if (x >= 548) PostMessageW(parent, WM_CLOSE, 0, 0);
            else if (x >= 504) ShowWindow(parent, SW_MINIMIZE);
            else { ReleaseCapture(); SendMessageW(parent, WM_NCLBUTTONDOWN, HTCAPTION, 0); }
        }
        return 0;
    }
    if (message == WM_PAINT && page) {
        PAINTSTRUCT paint;
        HDC dc = BeginPaint(window, &paint);
        {
            // Reuse the DPI-sized canvas; do not allocate/rescale the brand at 60 Hz.
            Graphics graphics(page->canvas);
            graphics.ScaleTransform(page->dpi / 96.0f, page->dpi / 96.0f);
            SolidBrush background(page->dark ? Color(255, 21, 21, 23) : Color(255, 255, 255, 255));
            graphics.FillRectangle(&background, Rect(48, 480, 504, 62));
            graphics.SetSmoothingMode(SmoothingModeAntiAlias);
            const int percent = static_cast<int>(page->progress.value);
            SolidBrush track(page->dark ? Color(255, 97, 102, 107) : Color(255, 233, 236, 242));
            SolidBrush ink(page->dark ? Color(255, 255, 255, 255) : Color(255, 15, 17, 21));
            FillProgress(graphics, track, 472.0f);
            FillProgress(graphics, ink, 472.0f * static_cast<REAL>(page->progress.value) / 100);
            FontFamily family(L"Microsoft YaHei UI");
            Font font(&family, 14, FontStyleRegular, UnitPixel);
            StringFormat centered;
            centered.SetAlignment(StringAlignmentCenter);
            centered.SetLineAlignment(StringAlignmentCenter);
            WCHAR caption[160];
            wsprintfW(caption, page->captions[page->progress.CaptionStage()], percent);
            if (page->runtime) lstrcpynW(caption, page->captions[5], 160);
            if (lstrcmpW(caption, page->lastCaption) != 0) {
                SetWindowTextW(window, caption);
                lstrcpynW(page->lastCaption, caption, 160);
            }
            if (!page->progress.succeeded) {
                Pen activity(page->dark ? Color(180, 255, 255, 255) : Color(160, 15, 17, 21), 1.5f);
                graphics.DrawArc(&activity, RectF(128, 519, 10, 10), static_cast<REAL>(GetTickCount64() % 1200) * .3f, 240);
            }
            graphics.DrawString(caption, -1, &font, RectF(48, 512, 504, 22), &centered, &ink);
            Graphics screen(dc);
            screen.DrawImage(page->canvas, 0, 0);
        }
        EndPaint(window, &paint);
        if (page->progress.value == 100) SetPropW(GetParent(window), L"EAiCodingInstaller.CompletedPercent", reinterpret_cast<HANDLE>(100));
        return 0;
    }
    if (message == WM_NCDESTROY && page) {
        KillTimer(window, 1);
        delete page->canvas;
        delete page->brand;
        GdiplusShutdown(page->gdiplus);
        delete page;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

// Runs on the NSIS UI thread; the stock installation section runs on its worker.
extern "C" __declspec(dllexport) HWND __cdecl InstallerShowProgress(HWND parent, HWND source,
        BOOL dark, UINT dpi, const WCHAR* brand, const WCHAR* preparing, const WCHAR* extracting,
        const WCHAR* copying, const WCHAR* registering, const WCHAR* cleaning, const WCHAR* runtime) {
    HINSTANCE module = GetModuleHandleW(nullptr);
    WNDCLASSW type = {};
    type.lpfnWndProc = ProgressProc;
    type.hInstance = module;
    type.lpszClassName = L"EAiCodingInstallerProgress";
    type.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    RegisterClassW(&type);
    auto* page = new (std::nothrow) ProgressPage{};
    if (!page) return nullptr;
    GdiplusStartupInput startup;
    if (GdiplusStartup(&page->gdiplus, &startup, nullptr) != Ok) { delete page; return nullptr; }
    HWND stockPage = GetParent(source);
    if (!SetWindowSubclass(stockPage, HiddenPageProc, 1, 0)) {
        GdiplusShutdown(page->gdiplus); delete page; return nullptr;
    }
    ShowWindow(stockPage, SW_HIDE);
    page->dark = dark != FALSE;
    page->dpi = dpi;
    const WCHAR* captions[] = {preparing, extracting, copying, registering, cleaning, runtime};
    for (int i = 0; i < 6; ++i) lstrcpynW(page->captions[i], captions[i], 128);
    page->brand = new Image(brand);
    if (page->brand->GetLastStatus() != Ok) {
        delete page->brand; GdiplusShutdown(page->gdiplus); delete page; return nullptr;
    }
    page->canvas = new Bitmap(MulDiv(600, dpi, 96), MulDiv(600, dpi, 96), PixelFormat32bppPARGB);
    if (page->canvas->GetLastStatus() != Ok) {
        delete page->canvas; delete page->brand; GdiplusShutdown(page->gdiplus); delete page; return nullptr;
    }
    {
        Graphics graphics(page->canvas);
        graphics.ScaleTransform(dpi / 96.0f, dpi / 96.0f);
        graphics.Clear(page->dark ? Color(255, 21, 21, 23) : Color(255, 255, 255, 255));
        graphics.SetInterpolationMode(InterpolationModeHighQualityBicubic);
        graphics.SetPixelOffsetMode(PixelOffsetModeHalf);
        graphics.DrawImage(page->brand, Rect(0, 174, 600, 196));
        FontFamily family(L"Microsoft YaHei UI");
        Font controls(&family, 16, FontStyleRegular, UnitPixel);
        StringFormat centered;
        centered.SetAlignment(StringAlignmentCenter);
        centered.SetLineAlignment(StringAlignmentCenter);
        SolidBrush ink(page->dark ? Color(255, 255, 255, 255) : Color(255, 15, 17, 21));
        graphics.DrawString(L"\x2212", -1, &controls, RectF(504, 8, 40, 32), &centered, &ink);
        graphics.DrawString(L"\x00d7", -1, &controls, RectF(548, 8, 40, 32), &centered, &ink);
    }
    HWND window = CreateWindowExW(0, type.lpszClassName, L"", WS_CHILD | WS_VISIBLE,
        0, 0, MulDiv(600, dpi, 96), MulDiv(600, dpi, 96), parent, nullptr, module, page);
    if (!window) { delete page->canvas; delete page->brand; GdiplusShutdown(page->gdiplus); delete page; }
    return window;
}

// NSIS has already reported success. Pump the UI for the bounded final animation,
// including a painted 100% frame, before constructing the interactive finish page.
extern "C" __declspec(dllexport) BOOL __cdecl InstallerFinishProgress(HWND window) {
    auto* page = reinterpret_cast<ProgressPage*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (!page) return FALSE;
    const ULONGLONG started = GetTickCount64();
    SetPropW(GetParent(window), L"EAiCodingInstaller.Succeeded", reinterpret_cast<HANDLE>(1));
    page->progress.Complete(started);
    while (IsWindow(window) && GetTickCount64() - started < 750) {
        MSG message;
        if (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) { PostQuitMessage(static_cast<int>(message.wParam)); return FALSE; }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        } else {
            MsgWaitForMultipleObjectsEx(0, nullptr, 16, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
        }
    }
    if (!IsWindow(window)) return FALSE;
    InvalidateRect(window, nullptr, FALSE);
    UpdateWindow(window);
    return TRUE;
}

static LRESULT CALLBACK FrameProc(HWND window, UINT message, WPARAM wparam,
                                 LPARAM lparam, UINT_PTR id, DWORD_PTR) {
    if (message == WM_NCCALCSIZE && wparam) return 0;
    if (message == WM_NCHITTEST) {
        const LRESULT hit = DefSubclassProc(window, message, wparam, lparam);
        // The installer has a fixed size; its page provides the drag area.
        return hit >= HTLEFT && hit <= HTBOTTOMRIGHT ? HTCLIENT : hit;
    }
    if (message == WM_NCDESTROY) RemoveWindowSubclass(window, FrameProc, id);
    return DefSubclassProc(window, message, wparam, lparam);
}

extern "C" __declspec(dllexport) HRESULT __cdecl InstallerApplyFrame(HWND window) {
    // NSIS may release its DLL reference before the window receives WM_NCDESTROY.
    HMODULE module = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_PIN | GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                           reinterpret_cast<LPCWSTR>(&FrameProc), &module)) return E_FAIL;
    if (!SetWindowSubclass(window, FrameProc, 1, 0)) return E_FAIL;
    const int stockControls[] = {1, 2, 3, 1028, 1256, 1034, 1035, 1036, 1037, 1038, 1039};
    for (int id : stockControls) {
        HWND child = GetDlgItem(window, id);
        if (child) {
            if (!SetWindowSubclass(child, HiddenPageProc, 1, 0)) return E_FAIL;
            ShowWindow(child, SW_HIDE);
        }
    }
    SetWindowLongW(window, GWL_STYLE, GetWindowLongW(window, GWL_STYLE) | WS_THICKFRAME);
    const DWMNCRENDERINGPOLICY policy = DWMNCRP_ENABLED;
    HRESULT result = DwmSetWindowAttribute(window, DWMWA_NCRENDERING_POLICY, &policy, sizeof(policy));
    if (FAILED(result)) return result;
    const DWORD rounded = 2;
    // Windows 10 does not support the Windows 11 corner preference.
    DwmSetWindowAttribute(window, 33, &rounded, sizeof(rounded));
    const MARGINS margins = {1, 1, 1, 1};
    result = DwmExtendFrameIntoClientArea(window, &margins);
    SetWindowPos(window, nullptr, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    return result;
}

// Present the first interactive page after resource preparation without keeping the installer topmost.
extern "C" __declspec(dllexport) BOOL __cdecl InstallerPresentWelcome(HWND window) {
    if (!IsWindowVisible(window)) return FALSE;
    if (!SetWindowPos(window, HWND_TOP, 0, 0, 0, 0,
                      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)) return FALSE;
    if (GetForegroundWindow() != window) {
        FLASHWINFO flash = {sizeof(flash), window, FLASHW_TRAY | FLASHW_TIMERNOFG, 0, 0};
        FlashWindowEx(&flash);
    }
    SetPropW(window, L"EAiCodingInstaller.Presented", reinterpret_cast<HANDLE>(1));
    return TRUE;
}
