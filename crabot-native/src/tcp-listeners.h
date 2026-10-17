// Read-only OS socket ownership. A listener alone never establishes app identity.
static std::set<int> ListeningPorts(int pid) {
  std::set<int> ports;
#ifdef _WIN32
  for (ULONG family : { AF_INET, AF_INET6 }) {
    DWORD bytes = 0;
    DWORD status = GetExtendedTcpTable(nullptr, &bytes, FALSE, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
    std::vector<unsigned char> buffer;
    for (int attempt = 0; status == ERROR_INSUFFICIENT_BUFFER && attempt < 3; attempt++) {
      if (!bytes || bytes > 16 * 1024 * 1024) throw std::runtime_error("Invalid TCP table size");
      buffer.resize(bytes);
      status = GetExtendedTcpTable(buffer.data(), &bytes, FALSE, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
    }
    if (status != NO_ERROR || buffer.empty()) throw std::runtime_error("Cannot inspect TCP listeners");
    if (family == AF_INET) {
      auto table = reinterpret_cast<MIB_TCPTABLE_OWNER_PID*>(buffer.data());
      if (buffer.size() < sizeof(DWORD) || table->dwNumEntries > (buffer.size() - sizeof(DWORD)) / sizeof(MIB_TCPROW_OWNER_PID)) throw std::runtime_error("Invalid TCP table");
      for (DWORD i = 0; i < table->dwNumEntries; i++) if (table->table[i].dwOwningPid == static_cast<DWORD>(pid)) ports.insert(ntohs(static_cast<u_short>(table->table[i].dwLocalPort)));
    } else {
      auto table = reinterpret_cast<MIB_TCP6TABLE_OWNER_PID*>(buffer.data());
      if (buffer.size() < sizeof(DWORD) || table->dwNumEntries > (buffer.size() - sizeof(DWORD)) / sizeof(MIB_TCP6ROW_OWNER_PID)) throw std::runtime_error("Invalid TCP6 table");
      for (DWORD i = 0; i < table->dwNumEntries; i++) if (table->table[i].dwOwningPid == static_cast<DWORD>(pid)) ports.insert(ntohs(static_cast<u_short>(table->table[i].dwLocalPort)));
    }
  }
#elif defined(__APPLE__)
  int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nullptr, 0);
  if (bytes < 0 || bytes > 4 * 1024 * 1024) throw std::runtime_error("Cannot enumerate process descriptors");
  std::vector<proc_fdinfo> descriptors(bytes / sizeof(proc_fdinfo) + 256);
  bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, descriptors.data(), descriptors.size() * sizeof(proc_fdinfo));
  if (bytes <= 0) throw std::runtime_error("Cannot inspect process descriptors");
  for (size_t i = 0; i < static_cast<size_t>(bytes) / sizeof(proc_fdinfo); i++) {
    if (descriptors[i].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
    socket_fdinfo socket{};
    if (proc_pidfdinfo(pid, descriptors[i].proc_fd, PROC_PIDFDSOCKETINFO, &socket, sizeof(socket)) != sizeof(socket)) {
      if (errno == EBADF || errno == ENOENT) continue; // descriptor closed during this read
      throw std::runtime_error("Cannot inspect process socket");
    }
    if (socket.psi.soi_kind == SOCKINFO_TCP && socket.psi.soi_proto.pri_tcp.tcpsi_state == TSI_S_LISTEN) {
      ports.insert(ntohs(static_cast<uint16_t>(socket.psi.soi_proto.pri_tcp.tcpsi_ini.insi_lport)));
    }
  }
#else
  const auto base = "/proc/" + std::to_string(pid);
  DIR* directory = opendir((base + "/fd").c_str());
  if (!directory) throw std::runtime_error("Cannot enumerate process descriptors");
  std::set<std::string> inodes;
  bool valid = true;
  while (auto entry = readdir(directory)) {
    std::string name(entry->d_name);
    if (name.find_first_not_of("0123456789") != std::string::npos) continue;
    char target[128];
    ssize_t size = readlink((base + "/fd/" + name).c_str(), target, sizeof(target));
    if (size < 0) { if (errno != ENOENT) valid = false; continue; }
    const std::string link(target, size);
    if (link.rfind("socket:[", 0) == 0 && link.back() == ']') inodes.insert(link.substr(8, link.size() - 9));
    if (inodes.size() > 65536) { valid = false; break; }
  }
  closedir(directory);
  if (!valid) throw std::runtime_error("Cannot inspect process descriptors");
  for (const auto& file : { "tcp", "tcp6" }) {
    std::ifstream table(base + "/net/" + file);
    if (!table) throw std::runtime_error("Cannot inspect process TCP table");
    std::string line; std::getline(table, line);
    while (std::getline(table, line)) {
      std::istringstream fields(line);
      std::vector<std::string> values; std::string value;
      while (fields >> value) values.push_back(value);
      if (values.size() < 10) throw std::runtime_error("Invalid process TCP table");
      if (values[3] != "0A" || !inodes.count(values[9])) continue;
      const auto colon = values[1].find(':');
      if (colon == std::string::npos) throw std::runtime_error("Invalid TCP port");
      const int port = std::stoi(values[1].substr(colon + 1), nullptr, 16);
      if (port < 1 || port > 65535) throw std::runtime_error("Invalid TCP port");
      ports.insert(port);
    }
    if (table.bad()) throw std::runtime_error("Cannot read process TCP table");
  }
#endif
  return ports;
}

static napi_value ListeningPortsCall(napi_env env, napi_callback_info info) {
  try {
    const int pid = Argument(env, info);
#ifdef _WIN32
    const auto self = Inspect(GetCurrentProcessId());
#else
    const auto self = Inspect(getpid());
#endif
    const auto before = Inspect(pid);
    if (!before.pid || before.owner != self.owner) throw std::runtime_error("Process is not owned by the current OS user");
    const auto ports = ListeningPorts(pid);
    const auto after = Inspect(pid);
    if (!after.pid || before.started != after.started || before.owner != after.owner) throw std::runtime_error("Process changed while inspecting listeners");
    napi_value result; napi_create_array(env, &result); unsigned index = 0;
    for (const int port : ports) napi_set_element(env, result, index++, Number(env, port));
    return result;
  } catch (const std::exception& error) { napi_throw_error(env, "CRABOT_PROCESS_IDENTITY", error.what()); return nullptr; }
}
