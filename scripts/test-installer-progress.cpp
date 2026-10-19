#include "../src-tauri/installer/extract-progress.h"
#include "../src-tauri/installer/progress.h"
#include <cassert>
#include <cstring>
#include <iostream>

int main() {
    ExtractionProgress extraction;
    // Pipe reads may split the number and its percent sign across arbitrary chunks.
    extraction.Read("\r 4", 3);
    extraction.Read("2", 1);
    extraction.Read("%", 1);
    assert(extraction.value == 42);
    const char* noise = " file100%name\r 3%\r 101%\r 9876%\r 9x%";
    extraction.Read(noise, std::strlen(noise));
    assert(extraction.value == 42);
    extraction.Read("\b 87%\r100%", 11);
    assert(extraction.value == 100);

    InstallProgress progress(0);
    progress.Advance(1, .5, 1000);
    progress.Tick(1250);
    assert(progress.value == 48);
    progress.Advance(1, .1, 1500);
    progress.Tick(1750);
    assert(progress.value == 48); // A stale percentage must never move the bar backwards.
    progress.Advance(4, 1, 2000);
    progress.Advance(4, 1, 600000);
    progress.Tick(601000);
    assert(progress.value < 100); // Time passing is not successful installation.
    progress.Complete(602000);
    progress.Tick(602600);
    assert(progress.value == 100);
    std::cout << "PASS fragmented 7-Zip percentages, noise/regressions and success-only 100%\n";
}
