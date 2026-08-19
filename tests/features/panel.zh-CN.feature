# language: zh-CN
功能: Embedded MockTools Panel 完整行为
  为了在不破坏请求拦截和配置持久化的前提下迭代 Panel
  作为开发者
  我希望所有用户功能、异常路径和降级路径都有可验证的行为规范

  背景:
    假如测试页面已加载未经修改的 "devtools-panel.js"
    并且每个场景开始前已隔离 IndexedDB、localStorage、Service Worker 和网络桩

  # 初始化和渲染

  @init @PANEL-001
  场景: 使用默认配置首次初始化
    当调用 "MockTools.init()"
    那么页面应挂载一个开放模式的 Shadow DOM Host
    并且应安装 Fetch 与 XMLHttpRequest 拦截器
    并且浮动按钮应显示 0 个请求和当前启用 Mock 数量

  @init @PANEL-002
  场景: 重复初始化保持幂等
    假如 MockTools 已完成初始化
    当再次调用 "MockTools.init()"
    那么应返回同一个公共 API
    并且不应重复挂载 Host 或重复包装网络 API

  @init @PANEL-003
  场景: 缺少原生网络 API 时仍可打开 Panel
    假如环境没有 Fetch 和 XMLHttpRequest
    当初始化 MockTools
    那么 Panel 仍应挂载
    并且不应因安装拦截器而抛出异常

  @init @PANEL-004
  场景大纲: Seed Mock 被规范化
    当使用包含 "<输入>" 的 Seed Mock 初始化
    那么规范化后的 "<字段>" 应为 "<结果>"

    例子:
      | 输入                    | 字段    | 结果             |
      | method=post             | method  | POST             |
      | url=/api/users          | pattern | /api/users       |
      | body={"ok":true}       | body    | 格式化 JSON 字符串 |
      | enabled 未提供          | enabled | true             |
      | status=0                | status  | 200              |

  @init @PANEL-005
  场景大纲: 应用浮动按钮预设位置
    当使用 "<位置>" 初始化 Panel
    那么浮动按钮应位于 "<预期>"

    例子:
      | 位置         | 预期       |
      | bottom-left  | 左下角 24px |
      | bottom-right | 右下角 24px |
      | top-left     | 左上角 24px |
      | top-right    | 右上角 24px |

  @init @PANEL-006
  场景: 应用对象形式的浮动按钮位置
    当使用 left、right、top、bottom 对象初始化
    那么每个已提供的坐标应原样应用
    并且每个未提供的坐标应为 auto

  # 持久化和重置

  @persistence @PANEL-007
  场景: IndexedDB 中的 Mock 优先于 Seed Mock
    假如 IndexedDB 已保存 Mock A
    并且初始化参数包含 Seed Mock B
    当持久化数据水合完成
    那么 Panel 应使用 Mock A
    并且不应把 Seed Mock B 合并进结果

  @persistence @PANEL-008
  场景: 迁移旧 localStorage Mock 到 IndexedDB
    假如 IndexedDB 中没有 Mock 记录
    并且旧 localStorage 中存在有效 Mock 数组
    当读取持久化 Mock
    那么旧 Mock 应写入 IndexedDB
    并且旧 localStorage 键应被删除

  @persistence @PANEL-009
  场景: IndexedDB 读取失败时回退 localStorage
    假如 IndexedDB 打开或读取失败
    并且 localStorage 中存在有效 Mock
    当完成水合
    那么内存状态应使用 localStorage Mock
    并且设置中应记录持久化错误

  @persistence @PANEL-010
  场景: 所有存储都不可用时保持会话内状态
    假如 IndexedDB 和 localStorage 读写都失败
    当用户新增并保存 Mock
    那么 Mock 在当前页面会话中仍应可用
    并且保存失败不应中断 Panel 交互

  @persistence @PANEL-011
  场景: 连续编辑只持久化最新 Mock 状态
    假如 300ms 内连续触发多次 Mock 保存
    当防抖写入完成
    那么最终存储应等于最后一次状态
    并且任意等待中的新状态应在前一次写入后继续刷新

  @persistence @PANEL-012
  场景: Snapshot 与活动 Snapshot ID 分别降级存储
    假如 IndexedDB 读写 Snapshot 失败
    当保存 Snapshot 并启用其中一个
    那么 Snapshot 列表和活动 ID 应写入对应 localStorage 键

  @reset @PANEL-013
  场景: 取消重置不修改任何状态
    假如 Panel 中存在请求、Mock 和 Snapshot
    当用户在重置确认框选择取消
    那么内存状态和持久化状态都应保持不变

  @reset @PANEL-014
  场景: 确认重置清空所有业务数据
    假如存在等待中的 Mock 写入以及活动 Snapshot
    当用户确认重置
    那么应等待旧写入结束后清空 IndexedDB 和 localStorage
    并且请求、Mock、Snapshot、选择模式和编辑草稿都应重置
    并且 Service Worker 应收到空 Mock 和空 Snapshot

  # Service Worker

  @service-worker @PANEL-015
  场景: 非安全上下文使用页面内拦截器
    假如页面不是安全 HTTP 上下文或浏览器不支持 Service Worker
    当初始化 MockTools
    那么不应注册 Service Worker
    并且 Fetch/XHR Mock 仍应在页面内工作

  @service-worker @PANEL-016
  场景: 相对路径注册失败后尝试根路径
    假如注册 "./mocktools-sw.js" 失败
    当设置 Service Worker
    那么应继续尝试注册 "/mocktools-sw.js"

  @service-worker @PANEL-017
  场景: Service Worker 控制页面后同步规则
    假如 Service Worker 注册成功并成为 controller
    当初始化完成或 controllerchange 发生
    那么状态徽章应显示 Active
    并且应同步当前 Mock 和活动 Snapshot 规则

  @service-worker @PANEL-018
  场景: 防止应用注销 MockTools Service Worker
    假如注册对象的脚本 URL 指向 mocktools-sw.js
    当应用调用 unregister
    那么调用应返回 false
    并且底层 unregister 不应执行

  @service-worker @PANEL-019
  场景: 应用注册其他 Service Worker 后触发恢复
    假如 MockTools Service Worker 模式已启用
    当应用成功注册另一个 Service Worker
    那么 MockTools 应在短延迟后尝试恢复自己的 controller

  @service-worker @PANEL-020
  场景大纲: 生命周期事件触发控制器恢复
    假如当前 controller 不是 MockTools Service Worker
    当发生 "<事件>"
    那么应尝试更新注册并向活动 Worker 发送 CLAIM_CLIENT

    例子:
      | 事件                         |
      | window focus                 |
      | document visibility=visible  |
      | controllerchange             |

  @service-worker @PANEL-021
  场景: Mock 同步发送给所有唯一 Worker 状态
    假如 controller、active、waiting 和 installing 中存在重复 Worker 引用
    当同步 Mock
    那么每个唯一 Worker 只应收到一次带递增版本号的 MOCKTOOLS_UPDATE_MOCKS
    并且全局 Mock 关闭时消息中的 mocks 应为空数组

  @service-worker @PANEL-022
  场景: Service Worker 恢复失败时降级但不中断 Panel
    假如注册、更新或 ready 等待失败
    当执行设置或恢复
    那么 Service Worker 状态应变为不可用
    并且页面内 Fetch/XHR 拦截应继续工作

  # Fetch

  @fetch @PANEL-023
  场景: Fetch 无匹配规则时透传并记录响应
    假如没有匹配的 Mock 或 Snapshot
    当 Fetch 返回成功响应
    那么原始 Fetch 应收到原始参数
    并且请求记录应包含状态、耗时、响应头和响应正文
    并且返回给应用的 Response 仍应可读取

  @fetch @PANEL-024
  场景: Fetch 命中普通 Mock
    假如页面内拦截模式存在匹配的启用 Mock
    当发起 Fetch
    那么不应调用原始 Fetch
    并且应在配置延迟后返回 Mock 状态、头和正文
    并且响应应包含 x-mocktools-mocked 与 mock-id 标记

  @fetch @PANEL-025
  场景: Snapshot 优先于普通 Mock
    假如同一请求同时匹配活动 Snapshot 和普通 Mock
    当发起 Fetch
    那么应返回 Snapshot 当前步骤
    并且记录应同时标记 mocked 和 snapshotted

  @fetch @PANEL-026
  场景: Service Worker 控制时不在页面内二次 Mock
    假如 MockTools Service Worker 正在控制页面
    当发起匹配请求并由 Worker 返回带标记响应
    那么页面拦截器应调用原始 Fetch
    并且只根据响应头记录 Mock 与 Snapshot 来源

  @fetch @PANEL-027
  场景: Fetch 网络异常被记录后继续抛出
    假如原始 Fetch 抛出带消息的错误
    当调用被拦截的 Fetch
    那么请求记录状态应为错误状态或 0
    并且应记录错误消息和耗时
    并且相同错误应继续抛给调用方

  @fetch @PANEL-028
  场景: 响应正文克隆或读取失败不保持 pending
    假如 Fetch 已返回状态但 clone 或正文读取失败
    当记录响应
    那么状态和响应头应先被提交
    并且记录应包含正文读取错误
    并且状态不应停留在 pending

  @fetch @PANEL-029
  场景大纲: 响应正文按类型和大小安全读取
    假如响应属于 "<类型>"
    当读取用于日志的正文
    那么日志正文应为 "<结果>"

    例子:
      | 类型                            | 结果                         |
      | application/octet-stream        | [binary response]            |
      | 无 ReadableStream 的短文本       | 完整文本                     |
      | 无 ReadableStream 且超过 256 KiB | 截断文本和 truncated 标记     |
      | ReadableStream 超过 256 KiB      | 取消 reader 并追加截断标记    |

  @fetch @PANEL-030
  场景大纲: Fetch 请求记录序列化常见输入
    当 Fetch 使用 "<输入>"
    那么请求记录中的 "<字段>" 应为 "<结果>"

    例子:
      | 输入                 | 字段           | 结果             |
      | Request 对象         | method/url     | Request 自带值   |
      | init.method 覆盖     | method         | 覆盖后的大写值   |
      | URLSearchParams      | requestBody    | 查询字符串       |
      | FormData             | requestBody    | [FormData]       |
      | Blob                 | requestBody    | 包含 MIME 的占位符 |
      | 循环引用对象          | requestBody    | String 回退值    |

  # XMLHttpRequest

  @xhr @PANEL-031
  场景: XHR 无匹配规则时透传并记录 loadend
    假如没有匹配规则
    当应用依次调用 open、setRequestHeader 和 send
    那么原始方法应收到完整参数
    并且 loadend 后记录应包含请求头、请求体、状态、响应头和响应体

  @xhr @PANEL-032
  场景: XHR 命中 Mock 时模拟完整完成事件
    假如页面内拦截模式存在匹配 Mock
    当发送 XHR
    那么不应调用原始 send
    并且延迟后 readyState、status、statusText、response 和 responseText 应被设置
    并且应依次派发 readystatechange、load、loadend

  @xhr @PANEL-033
  场景: XHR 命中 Snapshot 时带 Snapshot 标记
    假如活动 Snapshot 匹配该 XHR
    当发送 XHR
    那么响应头应同时包含 mocked、snapshotted 和规则 ID
    并且请求记录应标记 Snapshot 来源

  @xhr @PANEL-034
  场景: XHR 网络错误被记录
    假如原始 XHR 派发 error
    当错误发生
    那么请求记录应包含 "XHR network error"、状态和耗时

  @xhr @PANEL-035
  场景: 只读 XHR 属性无法 defineProperty 时使用赋值回退
    假如测试 XHR 拒绝 Object.defineProperty
    当生成 Mock XHR 响应
    那么实现应尝试直接赋值
    并且事件流程仍应完成

  # 匹配和互斥

  @matching @PANEL-036
  场景: 普通 pattern 使用 URL 子串匹配
    假如规则 pattern 为 "/api/users"
    当请求 URL 包含该子串
    那么规则应匹配
    并且不包含时不应匹配

  @matching @PANEL-037
  场景: 斜杠包裹的合法正则匹配 URL
    假如 pattern 是合法的 "/regex/" 形式
    当多次匹配不同 URL
    那么正则 lastIndex 应在每次匹配前重置
    并且结果应稳定

  @matching @PANEL-038
  场景: 非法正则回退为字面子串匹配
    假如斜杠包裹的 pattern 无法编译
    当匹配 URL
    那么不应抛出异常
    并且应按完整 pattern 字符串执行 includes

  @matching @PANEL-039
  场景: 精确 Method 与 ALL Method 都进入候选集
    假如同时存在 POST 规则、GET 规则和 ALL 规则
    当匹配 POST 请求
    那么候选集应只包含 POST 和 ALL
    并且保持原数组顺序用于相同优先级决策

  @matching @PANEL-040
  场景: 最长 pattern 优先且同长度保持原顺序
    假如多个启用规则都匹配同一请求
    当选择 Mock
    那么应优先选择 pattern 最长的规则
    并且同长度时选择原数组中更靠前的规则

  @matching @PANEL-041
  场景: 全局 Mock 开关关闭时跳过普通 Mock
    假如匹配规则处于启用状态
    但是全局 Mock 开关为关闭
    当请求到达
    那么普通 Mock 查找应返回空
    并且请求应继续透传或由 Snapshot 处理

  @matching @PANEL-042
  场景: 同端点只允许一个活动配置
    假如同一 method 与 pattern 下有多个 enabled 配置
    当初始化、导入或激活其中一个配置
    那么目标配置应保持 enabled
    并且同端点其他配置应被关闭
    并且其他端点配置不受影响

  # 请求历史和 Panel Shell

  @history @PANEL-043
  场景: 请求历史最多保留 200 条
    假如已记录 200 条请求
    当加入第 201 条请求
    那么最新请求应位于列表首部
    并且最旧请求应被移除

  @history @PANEL-044
  场景: URL、状态和排序过滤可组合
    假如请求列表包含不同 URL、状态和时间的记录
    当输入 URL 关键字、状态关键字并选择 oldest
    那么只显示同时满足两个过滤条件的记录
    并且结果顺序应从旧到新

  @history @PANEL-045
  场景: 选择请求展示详情与来源链接
    假如请求记录包含请求/响应头体和有效 mockId
    当用户选择该请求
    那么详情区应显示方法、URL、状态、耗时和各代码块
    并且来源仍存在时应显示可导航链接

  @history @PANEL-046
  场景: 请求来源已删除时保留历史标记但禁用导航
    假如记录标记为 Mock 或 Snapshot 但对应规则已删除
    当渲染详情
    那么应继续显示历史来源类型
    并且不应提供失效的规则导航 ID

  @history @PANEL-047
  场景: 清空请求同步清除选择
    假如已选择一条请求
    当点击清空按钮或调用 clearRequests
    那么请求数组应为空
    并且 selectedId 应为空且详情区显示空状态

  @panel-shell @PANEL-048
  场景: 打开和关闭 Panel 管理遮罩与页面滚动
    当点击浮动按钮打开 Panel
    那么 Panel 和遮罩应可见且 body 滚动应锁定
    当点击关闭、遮罩或 Panel 外部
    那么 Panel 应关闭且 body 原始 overflow 应恢复

  @panel-shell @PANEL-049
  场景: 浮动按钮自动收边并可恢复
    假如鼠标离开浮动按钮超过空闲时间
    当按钮位于左侧或右侧
    那么按钮应收进对应屏幕边缘并降低透明度
    当鼠标重新进入
    那么按钮应恢复原位置、尺寸和透明度

  # Mock 管理

  @mock @PANEL-050
  场景: 新增默认 Mock 规则
    当点击 Add Mock
    那么应创建启用的 GET /api/example 规则
    并且应切换到 Mock 编辑弹窗并持久化

  @mock @PANEL-051
  场景: 从请求创建 Mock
    假如存在一条已完成请求
    当从请求菜单选择 Create Mock
    那么新规则应继承方法、路径、状态、响应头和响应体
    并且应成为该端点唯一活动配置

  @mock @PANEL-052
  场景: 保存 Mock 编辑表单
    假如用户修改名称、启用状态、方法、pattern、状态、延迟、头和正文
    当点击 Save
    那么所有字段应按类型写回规则
    并且活动输入应先 blur 以提交最新值
    并且保存成功状态应显示约 1.5 秒

  @mock @PANEL-053
  场景: Mock Headers JSON 无效时保留旧值
    假如当前规则已有有效 headers
    并且表单 headers 不是合法 JSON
    当保存 Mock
    那么旧 headers 应作为 fallback 保留
    并且其他合法字段仍应保存

  @mock @PANEL-054
  场景: 从现有配置新增同端点 Config
    假如端点存在源配置
    当点击 Add Config
    那么新配置应继承 method、pattern、group 和 alias
    并且默认关闭、状态 200、延迟 0、正文为空

  @mock @PANEL-055
  场景: 编辑端点级字段传播到组内所有 Config
    假如同端点包含多个配置
    当修改 method、pattern、group 或 aliasName
    那么组内所有配置应同步更新对应字段
    并且单一活动约束应重新计算

  @mock @PANEL-056
  场景: 快捷状态、延迟、模板和格式化更新编辑值
    当点击状态或延迟快捷值、响应模板或 Format
    那么目标输入应更新为选择值或格式化 JSON
    并且合法 JSON 显示成功反馈而非法 JSON 显示错误反馈

  @mock @PANEL-057
  场景: 单项、整组和批量删除正确维护选择
    假如存在多个端点组且当前选择位于待删除项
    当分别执行删除 Config、删除组或批量删除已选组
    那么只应删除目标规则
    并且失效的 selectedMockId 应清空
    并且批量选择模式应退出并持久化

  # Snapshot 管理与回放

  @snapshot @PANEL-058
  场景: 从选中的已完成请求创建 Snapshot
    假如用户选择了多个已完成请求和一个 pending 请求
    当输入名称并保存 Snapshot
    那么 pending 请求应被忽略
    并且同 method 与 pattern 的请求应按开始时间组成多步骤规则
    并且 Panel 应切换到新 Snapshot

  @snapshot @PANEL-059
  场景大纲: 创建 Snapshot 的取消和空结果路径
    假如进入请求选择模式
    当 "<动作>"
    那么 "<结果>"

    例子:
      | 动作                 | 结果                         |
      | 取消保存             | 退出模式且不创建 Snapshot     |
      | Prompt 返回空值      | 保持数据不变                 |
      | 没有已完成请求       | 显示告警且不创建 Snapshot     |
      | 点击 All 后再 None   | 选择集合先全选再清空          |

  @snapshot @PANEL-060
  场景: Snapshot 回放优先且切换活动项重置游标
    假如存在活动 Snapshot 和普通 Mock
    当请求命中 Snapshot 后切换或关闭活动 Snapshot
    那么 Snapshot 应优先响应
    并且 playbackIndices 应在活动项变化时清空

  @snapshot @PANEL-061
  场景大纲: Snapshot 步骤耗尽后的 overflow 行为
    假如规则的所有响应步骤都已使用
    并且 overflow 为 "<模式>"
    当再次请求
    那么应 "<结果>"

    例子:
      | 模式        | 结果                         |
      | repeat-last | 重复最后一步                 |
      | loop        | 返回第一步并从第二步继续计数 |
      | bypass      | 返回空并继续普通 Mock 或网络 |

  @snapshot @PANEL-062
  场景: Snapshot 编辑使用深拷贝草稿
    假如选择一个已保存 Snapshot
    当修改名称、规则方法、pattern 或 overflow 但尚未保存
    那么原 Snapshot 应保持不变
    并且点击 Cancel 应重新从原 Snapshot 创建草稿

  @snapshot @PANEL-063
  场景: 新增、删除和移动 Snapshot 规则
    假如正在编辑 Snapshot
    当新增规则、删除规则、向上移动或向下移动
    那么规则数组和 selectedSnapshotRuleIdx 应保持一致
    并且第一项不可上移、最后一项不可下移

  @snapshot @PANEL-064
  场景: 新增步骤复制最后一步且删除只影响目标步骤
    假如规则已有一个包含 headers 的响应步骤
    当新增步骤
    那么状态、延迟、headers 和 body 应被深复制
    当删除其中一个步骤
    那么其他步骤应保持不变

  @snapshot @PANEL-065
  场景: 保存活动 Snapshot 同步 Service Worker
    假如正在编辑的 Snapshot 是活动项
    当保存有效草稿
    那么持久化列表应替换对应 Snapshot
    并且 Service Worker 应收到更新后的规则
    并且保存成功状态应显示约 1.5 秒

  @snapshot @PANEL-066
  场景: 删除或批量删除活动 Snapshot
    假如待删除集合包含活动和当前选中的 Snapshot
    当用户确认删除
    那么活动 ID 与回放游标应清空
    并且应选中剩余列表第一项或空值
    并且应同步存储和 Service Worker

  # 导入导出

  @backup @PANEL-067
  场景: 导出全部 Mock 为版本化 JSON
    当导出 Mock
    那么下载内容应包含 version、exportedAt 和 mocks
    并且文件名应包含当天日期
    并且临时 Object URL 应被撤销

  @backup @PANEL-068
  场景大纲: 导入支持的 Mock 文件形态
    假如选择的 JSON 文件是 "<形态>"
    当导入 Mock
    那么应规范化规则并执行单一活动约束

    例子:
      | 形态                    |
      | 顶层 Mock 数组          |
      | 包含 mocks 数组的对象   |

  @backup @PANEL-069
  场景: Mock 导入文件无效时保留原状态
    假如文件不是 JSON 或不包含 Mock 数组
    当尝试导入
    那么应显示 Import failed 告警
    并且现有 Mock 不应被替换

  @backup @PANEL-070
  场景: 导出单个和全部 Snapshot
    假如存在名称含特殊字符的 Snapshot
    当分别导出单个和全部 Snapshot
    那么单个文件名中的特殊字符应替换为下划线
    并且 payload 应分别包含 snapshot 或 snapshots
    并且空列表时全部导出不应下载文件

  @backup @PANEL-071
  场景: Snapshot 导入验证结构并重新生成 ID
    假如文件包含单个 snapshot、snapshots 数组或顶层数组
    当导入有效 name 和 rules 项
    那么每个 Snapshot 与每条规则都应获得新 ID
    并且无效项应过滤且全无效时显示失败告警

  # 设置、渲染、工具和公共 API

  @settings @PANEL-072
  场景: 设置弹窗显示存储与 Service Worker 状态
    当打开设置
    那么应刷新 storage estimate
    并且显示剩余配额或 Estimate unavailable
    并且显示 Service Worker Active 或 fallback 状态以及版本号

  @rendering @PANEL-073
  场景: JSON 高亮处理对象、数组和普通文本
    假如代码块值分别为合法 JSON 和非 JSON 文本
    当渲染详情
    那么合法 JSON 应格式化并区分 key、string、number、boolean、null
    并且普通文本应安全转义后原样展示

  @security @PANEL-074
  场景: 所有用户可控文本在 HTML 和属性中被转义
    假如 URL、规则名、group、headers 或 body 包含 HTML、引号和反引号
    当渲染 Panel
    那么不得创建注入的元素、事件处理器或脚本
    并且属性选择器转义应能定位包含特殊字符的 ID

  @utility @PANEL-075
  场景大纲: Headers 输入按优先级解析
    当解析 "<输入>"
    那么结果应为 "<结果>"

    例子:
      | 输入                         | 结果                 |
      | {"x-a":"1"}               | JSON 对象            |
      | ({"x-a":"1"})             | 宽松对象字面量       |
      | x-a: 1 换行 x-b: 2           | 原始 Header 键值对象 |
      | 空字符串                     | 空对象               |
      | 无法解析且无冒号             | 调用方 fallback      |

  @utility @PANEL-076
  场景: 复制按钮成功与失败路径都不破坏 Panel
    假如 clipboard.writeText 成功或拒绝
    当点击代码块复制按钮
    那么成功时应短暂显示 copied 状态
    并且失败时不应修改业务状态或导致重新初始化

  @rendering @PANEL-077
  场景: 重渲染恢复焦点、光标、滚动和折叠状态
    假如用户正在输入搜索、规则或 Snapshot 字段并滚动各区域
    当新请求触发 notify 重渲染
    那么受支持输入应恢复焦点与 selection range
    并且列表、详情、textarea 滚动位置和折叠区应保持

  @utility @PANEL-078
  场景: notify 在同一动画帧合并多次更新
    假如同一帧内连续调用 notify
    当 requestAnimationFrame 回调执行
    那么每个 subscriber 只应渲染一次
    并且无 requestAnimationFrame 时应使用 setTimeout 回退

  @api @PANEL-079
  场景: 公共 API addMock 与 getMocks
    当通过 addMock 加入非规范化规则
    那么规则应被规范化、选中、持久化并同步 Service Worker
    并且 getMocks 应返回新数组而不是内部数组引用

  @api @PANEL-080
  场景: 公共 API getRequests 与 clearRequests
    假如已有请求记录且其中一条被选择
    当调用 getRequests
    那么应返回新数组并保留记录顺序
    当调用 clearRequests
    那么记录和选择都应清空并触发渲染
