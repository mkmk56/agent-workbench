/**
 * Icon set adapter — every production icon in the GUI comes from here.
 *
 * The app used to import these slots from lucide-react 1.72.0. Phase 4 shipped a
 * side-by-side preview (#/preview/reicon) and the swap below follows that table:
 * the exported names are kept as the UI slot names the code already uses, and the
 * right-hand side is the reicon-react 1.2.6 component that renders it.
 *
 * Weight: reicon defaults to `Outline`, which is what every passive icon wants.
 * Call sites pass `weight="Filled"` only for active/selected states (nav rail
 * selection, selected chat row, active settings tab, wake switch that is on).
 * Sizes are unchanged from the lucide build (22 / 15 / 14 / 13 / 12 / 9 px).
 *
 * Both libraries draw on a 24px grid, so no layout or spacing change is needed.
 *
 * Slots with no exact Reicon counterpart (recorded in the migration report, not
 * forced): Bot -> Cpu, Circle -> Record, FileClock -> FileText,
 * FileSpreadsheet -> DocumentText2, UserCog -> UserEdit, ExternalLink -> Export5.
 *
 * Icons derived from the Solar Icon Set by 480 Design (CC BY 4.0), see README.
 */

export { WavePulse as Activity } from 'reicon-react';
export { AlarmClock } from 'reicon-react';
export { AlertTriangle } from 'reicon-react';
export { Archive } from 'reicon-react';
export { ArchiveUp as ArchiveRestore } from 'reicon-react';
export { ArrowLeft } from 'reicon-react';
export { AtSign } from 'reicon-react';
export { BellRing } from 'reicon-react';
export { Cpu as Bot } from 'reicon-react';
export { Check } from 'reicon-react';
export { ChevronDown } from 'reicon-react';
export { ChevronRight } from 'reicon-react';
export { ChevronUp } from 'reicon-react';
export { Record as Circle } from 'reicon-react';
export { AlertCircle as CircleAlert } from 'reicon-react';
export { CheckCircle as CircleCheck } from 'reicon-react';
export { XCircle as CircleX } from 'reicon-react';
export { Clock3 } from 'reicon-react';
export { Copy } from 'reicon-react';
export { ArrowToDownRight as CornerDownRight } from 'reicon-react';
export { ArrowToTopLeft as CornerUpLeft } from 'reicon-react';
export { Database } from 'reicon-react';
export { Download } from 'reicon-react';
export { Export5 as ExternalLink } from 'reicon-react';
export { Eye } from 'reicon-react';
export { EyeOff } from 'reicon-react';
export { File } from 'reicon-react';
export { FileText as FileClock } from 'reicon-react';
export { CodeFile as FileCode2 } from 'reicon-react';
export { DocumentSketch as FilePenLine } from 'reicon-react';
export { Files } from 'reicon-react';
export { DocumentText2 as FileSpreadsheet } from 'reicon-react';
export { FileText } from 'reicon-react';
export { History } from 'reicon-react';
export { Hourglass } from 'reicon-react';
export { Image } from 'reicon-react';
export { Inbox } from 'reicon-react';
export { InfoCircle as Info } from 'reicon-react';
export { Key as KeyRound } from 'reicon-react';
export { Layout as LayoutDashboard } from 'reicon-react';
export { Link2 } from 'reicon-react';
export { Checklist as ListChecks } from 'reicon-react';
export { Loader as Loader2 } from 'reicon-react';
export { Envelope as Mail } from 'reicon-react';
export { MessageSquare } from 'reicon-react';
export { MessageSquare as MessagesSquare } from 'reicon-react';
export { Moon } from 'reicon-react';
export { MoreH as MoreHorizontal } from 'reicon-react';
export { Sidebar as PanelLeft } from 'reicon-react';
export { SidebarLeft as PanelLeftClose } from 'reicon-react';
export { SidebarLeft as PanelLeftOpen } from 'reicon-react';
export { Paperclip } from 'reicon-react';
export { Pen as Pencil } from 'reicon-react';
export { Play } from 'reicon-react';
export { Plus } from 'reicon-react';
export { Power } from 'reicon-react';
export { Refresh as RefreshCw } from 'reicon-react';
export { RotateLeft as RotateCcw } from 'reicon-react';
export { RotateRight as RotateCw } from 'reicon-react';
export { Save } from 'reicon-react';
export { DocumentText as ScrollText } from 'reicon-react';
export { Search } from 'reicon-react';
export { Send } from 'reicon-react';
export { Server } from 'reicon-react';
export { Settings } from 'reicon-react';
export { Shield4 as Shield } from 'reicon-react';
export { ShieldAlert } from 'reicon-react';
export { ShieldCheck } from 'reicon-react';
export { FaceSmile as Smile } from 'reicon-react';
export { Sun } from 'reicon-react';
export { TerminalSquare as Terminal } from 'reicon-react';
export { Timer } from 'reicon-react';
export { Trash2 } from 'reicon-react';
export { AlertTriangle as TriangleAlert } from 'reicon-react';
export { Undo as Undo2 } from 'reicon-react';
export { Upload } from 'reicon-react';
export { UserEdit as UserCog } from 'reicon-react';
export { UserAdd as UserPlus } from 'reicon-react';
export { User as UserRound } from 'reicon-react';
export { Users } from 'reicon-react';
export { X } from 'reicon-react';

export type { IconProps, IconWeight } from 'reicon-react';
