; Infinite Studio 安装程序定制：覆盖安装
;
; electron-builder 默认在安装新版本前会先静默运行旧版本的卸载程序，把整个安装目录删掉再重装。
; 这里改成“覆盖安装”：
;   1. 欢迎页检测已安装的版本，明确提示将覆盖安装到原目录、保留设置和插件；
;   2. 安装程序记下目标目录；旧版卸载程序在“更新模式”下如果发现目标目录就是自己的目录，
;      就不再删除程序文件，由新安装程序直接覆盖。
;   （注意：第 2 步依赖“旧版本”的卸载程序已经包含这段逻辑，所以从本版本之后的升级才生效。）

!define IS_MARKER_KEY "Software\InfiniteStudioSetup"
!define IS_MARKER_VALUE "OverwriteTarget"

!ifndef BUILD_UNINSTALLER

  ; 在 .onInit 中先记一次（静默安装 /S 不经过页面，也能覆盖安装）
  !macro customInit
    WriteRegStr HKCU "${IS_MARKER_KEY}" "${IS_MARKER_VALUE}" "$INSTDIR"
  !macroend

  !macro customWelcomePage
    Var isOldVersion
    Var isOldDir
    Var isWelcomeTitle
    Var isWelcomeText

    Function isWelcomePre
      StrCpy $isOldVersion ""
      StrCpy $isOldDir ""
      ReadRegStr $isOldVersion HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion"
      ReadRegStr $isOldDir HKCU "Software\${APP_GUID}" "InstallLocation"
      ${if} $isOldVersion == ""
        ReadRegStr $isOldVersion HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion"
        ReadRegStr $isOldDir HKLM "Software\${APP_GUID}" "InstallLocation"
      ${endif}

      ${if} $isOldVersion != ""
        StrCpy $isWelcomeTitle "覆盖安装 ${PRODUCT_NAME}"
        StrCpy $isWelcomeText "检测到本机已安装 ${PRODUCT_NAME} $isOldVersion$\r$\n$isOldDir$\r$\n$\r$\n本次将直接覆盖安装为 ${VERSION}，不会先卸载。$\r$\n你的设置、空间、登录账户和插件配置都会保留。$\r$\n$\r$\n请先关闭正在运行的 ${PRODUCT_NAME}，然后点击“下一步”。"
      ${else}
        StrCpy $isWelcomeTitle "安装 ${PRODUCT_NAME}"
        StrCpy $isWelcomeText "欢迎使用 ${PRODUCT_NAME} ${VERSION} 安装向导。$\r$\n$\r$\n无界工作室：极简、高度个性化的桌面 IDE。$\r$\n$\r$\n点击“下一步”继续。"
      ${endif}
    FunctionEnd

    !define MUI_PAGE_CUSTOMFUNCTION_PRE isWelcomePre
    !define MUI_WELCOMEPAGE_TITLE "$isWelcomeTitle"
    !define MUI_WELCOMEPAGE_TEXT "$isWelcomeText"
    !insertmacro MUI_PAGE_WELCOME
  !macroend

  ; 选完目录之后的“隐形页”：记下最终目标目录，供旧版卸载程序判断是否覆盖安装
  !macro customPageAfterChangeDir
    Function isRecordTarget
      WriteRegStr HKCU "${IS_MARKER_KEY}" "${IS_MARKER_VALUE}" "$INSTDIR"
      Abort
    FunctionEnd
    Page custom isRecordTarget
  !macroend

  !macro customInstall
    DeleteRegKey HKCU "${IS_MARKER_KEY}"
  !macroend

!else

  !macro customRemoveFiles
    Var /GLOBAL isTarget
    StrCpy $isTarget ""
    ${if} ${isUpdated}
      ReadRegStr $isTarget HKCU "${IS_MARKER_KEY}" "${IS_MARKER_VALUE}"
    ${endif}

    ${if} $isTarget != ""
    ${andIf} $isTarget == $INSTDIR
      DetailPrint "覆盖安装：保留 $INSTDIR"
    ${elseIf} $isTarget != ""
    ${andIf} "$isTarget\${APP_FILENAME}" == $INSTDIR
      DetailPrint "覆盖安装：保留 $INSTDIR"
    ${else}
      ; 真正卸载，或者新版本装到了别的目录：删除旧目录
      SetOutPath $TEMP
      RMDir /r $INSTDIR
    ${endif}
  !macroend

!endif
