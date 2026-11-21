package shop

class Report {
    @Suppress("unused")
    fun render(rows: List<String>): String {
        val out = StringBuilder()
        rows.forEach { r ->
            out.append(r)
        }
        for (row in rows) {
            if (row.isEmpty() || row.startsWith("#")) {
                continue
            }
            out.append("""
                while (true) {
                """)
        }
        val c = '"'
        return out.toString()
    }
}
