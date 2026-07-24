#include "lbug/include/lbug_rs.h"
#include <algorithm>
#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <initializer_list>
#include <iterator>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace rust {
inline namespace cxxbridge1 {
// #include "rust/cxx.h"

#ifndef CXXBRIDGE1_PANIC
#define CXXBRIDGE1_PANIC
template <typename Exception>
void panic [[noreturn]] (const char *msg);
#endif // CXXBRIDGE1_PANIC

struct unsafe_bitcopy_t;

namespace {
template <typename T>
class impl;
} // namespace

class Opaque;

template <typename T>
::std::size_t size_of();
template <typename T>
::std::size_t align_of();

#ifndef CXXBRIDGE1_RUST_STRING
#define CXXBRIDGE1_RUST_STRING
class String final {
public:
  String() noexcept;
  String(const String &) noexcept;
  String(String &&) noexcept;
  ~String() noexcept;

  String(const std::string &);
  String(const char *);
  String(const char *, std::size_t);
  String(const char16_t *);
  String(const char16_t *, std::size_t);

  static String lossy(const std::string &) noexcept;
  static String lossy(const char *) noexcept;
  static String lossy(const char *, std::size_t) noexcept;
  static String lossy(const char16_t *) noexcept;
  static String lossy(const char16_t *, std::size_t) noexcept;

  String &operator=(const String &) &noexcept;
  String &operator=(String &&) &noexcept;

  explicit operator std::string() const;

  const char *data() const noexcept;
  std::size_t size() const noexcept;
  std::size_t length() const noexcept;
  bool empty() const noexcept;

  const char *c_str() noexcept;

  std::size_t capacity() const noexcept;
  void reserve(size_t new_cap) noexcept;

  using iterator = char *;
  iterator begin() noexcept;
  iterator end() noexcept;

  using const_iterator = const char *;
  const_iterator begin() const noexcept;
  const_iterator end() const noexcept;
  const_iterator cbegin() const noexcept;
  const_iterator cend() const noexcept;

  bool operator==(const String &) const noexcept;
  bool operator!=(const String &) const noexcept;
  bool operator<(const String &) const noexcept;
  bool operator<=(const String &) const noexcept;
  bool operator>(const String &) const noexcept;
  bool operator>=(const String &) const noexcept;

  void swap(String &) noexcept;

  String(unsafe_bitcopy_t, const String &) noexcept;

private:
  struct lossy_t;
  String(lossy_t, const char *, std::size_t) noexcept;
  String(lossy_t, const char16_t *, std::size_t) noexcept;
  friend void swap(String &lhs, String &rhs) noexcept { lhs.swap(rhs); }

  std::array<std::uintptr_t, 3> repr;
};
#endif // CXXBRIDGE1_RUST_STRING

#ifndef CXXBRIDGE1_RUST_STR
#define CXXBRIDGE1_RUST_STR
class Str final {
public:
  Str() noexcept;
  Str(const String &) noexcept;
  Str(const std::string &);
  Str(const char *);
  Str(const char *, std::size_t);

  Str &operator=(const Str &) &noexcept = default;

  explicit operator std::string() const;

  const char *data() const noexcept;
  std::size_t size() const noexcept;
  std::size_t length() const noexcept;
  bool empty() const noexcept;

  Str(const Str &) noexcept = default;
  ~Str() noexcept = default;

  using iterator = const char *;
  using const_iterator = const char *;
  const_iterator begin() const noexcept;
  const_iterator end() const noexcept;
  const_iterator cbegin() const noexcept;
  const_iterator cend() const noexcept;

  bool operator==(const Str &) const noexcept;
  bool operator!=(const Str &) const noexcept;
  bool operator<(const Str &) const noexcept;
  bool operator<=(const Str &) const noexcept;
  bool operator>(const Str &) const noexcept;
  bool operator>=(const Str &) const noexcept;

  void swap(Str &) noexcept;

private:
  class uninit;
  Str(uninit) noexcept;
  friend impl<Str>;

  std::array<std::uintptr_t, 2> repr;
};
#endif // CXXBRIDGE1_RUST_STR

#ifndef CXXBRIDGE1_RUST_SLICE
#define CXXBRIDGE1_RUST_SLICE
namespace detail {
template <bool>
struct copy_assignable_if {};

template <>
struct copy_assignable_if<false> {
  copy_assignable_if() noexcept = default;
  copy_assignable_if(const copy_assignable_if &) noexcept = default;
  copy_assignable_if &operator=(const copy_assignable_if &) &noexcept = delete;
  copy_assignable_if &operator=(copy_assignable_if &&) &noexcept = default;
};
} // namespace detail

template <typename T>
class Slice final
    : private detail::copy_assignable_if<std::is_const<T>::value> {
public:
  using value_type = T;

  Slice() noexcept;
  Slice(T *, std::size_t count) noexcept;

  template <typename C>
  explicit Slice(C& c) : Slice(c.data(), c.size()) {}

  Slice &operator=(const Slice<T> &) &noexcept = default;
  Slice &operator=(Slice<T> &&) &noexcept = default;

  T *data() const noexcept;
  std::size_t size() const noexcept;
  std::size_t length() const noexcept;
  bool empty() const noexcept;

  T &operator[](std::size_t n) const noexcept;
  T &at(std::size_t n) const;
  T &front() const noexcept;
  T &back() const noexcept;

  Slice(const Slice<T> &) noexcept = default;
  ~Slice() noexcept = default;

  class iterator;
  iterator begin() const noexcept;
  iterator end() const noexcept;

  void swap(Slice &) noexcept;

private:
  class uninit;
  Slice(uninit) noexcept;
  friend impl<Slice>;
  friend void sliceInit(void *, const void *, std::size_t) noexcept;
  friend void *slicePtr(const void *) noexcept;
  friend std::size_t sliceLen(const void *) noexcept;

  std::array<std::uintptr_t, 2> repr;
};

template <typename T>
class Slice<T>::iterator final {
public:
  using iterator_category = std::random_access_iterator_tag;
  using value_type = T;
  using difference_type = std::ptrdiff_t;
  using pointer = typename std::add_pointer<T>::type;
  using reference = typename std::add_lvalue_reference<T>::type;

  reference operator*() const noexcept;
  pointer operator->() const noexcept;
  reference operator[](difference_type) const noexcept;

  iterator &operator++() noexcept;
  iterator operator++(int) noexcept;
  iterator &operator--() noexcept;
  iterator operator--(int) noexcept;

  iterator &operator+=(difference_type) noexcept;
  iterator &operator-=(difference_type) noexcept;
  iterator operator+(difference_type) const noexcept;
  iterator operator-(difference_type) const noexcept;
  difference_type operator-(const iterator &) const noexcept;

  bool operator==(const iterator &) const noexcept;
  bool operator!=(const iterator &) const noexcept;
  bool operator<(const iterator &) const noexcept;
  bool operator<=(const iterator &) const noexcept;
  bool operator>(const iterator &) const noexcept;
  bool operator>=(const iterator &) const noexcept;

private:
  friend class Slice;
  void *pos;
  std::size_t stride;
};

template <typename T>
Slice<T>::Slice() noexcept {
  sliceInit(this, reinterpret_cast<void *>(align_of<T>()), 0);
}

template <typename T>
Slice<T>::Slice(T *s, std::size_t count) noexcept {
  assert(s != nullptr || count == 0);
  sliceInit(this,
            s == nullptr && count == 0
                ? reinterpret_cast<void *>(align_of<T>())
                : const_cast<typename std::remove_const<T>::type *>(s),
            count);
}

template <typename T>
T *Slice<T>::data() const noexcept {
  return reinterpret_cast<T *>(slicePtr(this));
}

template <typename T>
std::size_t Slice<T>::size() const noexcept {
  return sliceLen(this);
}

template <typename T>
std::size_t Slice<T>::length() const noexcept {
  return this->size();
}

template <typename T>
bool Slice<T>::empty() const noexcept {
  return this->size() == 0;
}

template <typename T>
T &Slice<T>::operator[](std::size_t n) const noexcept {
  assert(n < this->size());
  auto ptr = static_cast<char *>(slicePtr(this)) + size_of<T>() * n;
  return *reinterpret_cast<T *>(ptr);
}

template <typename T>
T &Slice<T>::at(std::size_t n) const {
  if (n >= this->size()) {
    panic<std::out_of_range>("rust::Slice index out of range");
  }
  return (*this)[n];
}

template <typename T>
T &Slice<T>::front() const noexcept {
  assert(!this->empty());
  return (*this)[0];
}

template <typename T>
T &Slice<T>::back() const noexcept {
  assert(!this->empty());
  return (*this)[this->size() - 1];
}

template <typename T>
typename Slice<T>::iterator::reference
Slice<T>::iterator::operator*() const noexcept {
  return *static_cast<T *>(this->pos);
}

template <typename T>
typename Slice<T>::iterator::pointer
Slice<T>::iterator::operator->() const noexcept {
  return static_cast<T *>(this->pos);
}

template <typename T>
typename Slice<T>::iterator::reference Slice<T>::iterator::operator[](
    typename Slice<T>::iterator::difference_type n) const noexcept {
  auto ptr = static_cast<char *>(this->pos) + this->stride * n;
  return *reinterpret_cast<T *>(ptr);
}

template <typename T>
typename Slice<T>::iterator &Slice<T>::iterator::operator++() noexcept {
  this->pos = static_cast<char *>(this->pos) + this->stride;
  return *this;
}

template <typename T>
typename Slice<T>::iterator Slice<T>::iterator::operator++(int) noexcept {
  auto ret = iterator(*this);
  this->pos = static_cast<char *>(this->pos) + this->stride;
  return ret;
}

template <typename T>
typename Slice<T>::iterator &Slice<T>::iterator::operator--() noexcept {
  this->pos = static_cast<char *>(this->pos) - this->stride;
  return *this;
}

template <typename T>
typename Slice<T>::iterator Slice<T>::iterator::operator--(int) noexcept {
  auto ret = iterator(*this);
  this->pos = static_cast<char *>(this->pos) - this->stride;
  return ret;
}

template <typename T>
typename Slice<T>::iterator &Slice<T>::iterator::operator+=(
    typename Slice<T>::iterator::difference_type n) noexcept {
  this->pos = static_cast<char *>(this->pos) + this->stride * n;
  return *this;
}

template <typename T>
typename Slice<T>::iterator &Slice<T>::iterator::operator-=(
    typename Slice<T>::iterator::difference_type n) noexcept {
  this->pos = static_cast<char *>(this->pos) - this->stride * n;
  return *this;
}

template <typename T>
typename Slice<T>::iterator Slice<T>::iterator::operator+(
    typename Slice<T>::iterator::difference_type n) const noexcept {
  auto ret = iterator(*this);
  ret.pos = static_cast<char *>(this->pos) + this->stride * n;
  return ret;
}

template <typename T>
typename Slice<T>::iterator Slice<T>::iterator::operator-(
    typename Slice<T>::iterator::difference_type n) const noexcept {
  auto ret = iterator(*this);
  ret.pos = static_cast<char *>(this->pos) - this->stride * n;
  return ret;
}

template <typename T>
typename Slice<T>::iterator::difference_type
Slice<T>::iterator::operator-(const iterator &other) const noexcept {
  auto diff = std::distance(static_cast<char *>(other.pos),
                            static_cast<char *>(this->pos));
  return diff / static_cast<typename Slice<T>::iterator::difference_type>(
                    this->stride);
}

template <typename T>
bool Slice<T>::iterator::operator==(const iterator &other) const noexcept {
  return this->pos == other.pos;
}

template <typename T>
bool Slice<T>::iterator::operator!=(const iterator &other) const noexcept {
  return this->pos != other.pos;
}

template <typename T>
bool Slice<T>::iterator::operator<(const iterator &other) const noexcept {
  return this->pos < other.pos;
}

template <typename T>
bool Slice<T>::iterator::operator<=(const iterator &other) const noexcept {
  return this->pos <= other.pos;
}

template <typename T>
bool Slice<T>::iterator::operator>(const iterator &other) const noexcept {
  return this->pos > other.pos;
}

template <typename T>
bool Slice<T>::iterator::operator>=(const iterator &other) const noexcept {
  return this->pos >= other.pos;
}

template <typename T>
typename Slice<T>::iterator Slice<T>::begin() const noexcept {
  iterator it;
  it.pos = slicePtr(this);
  it.stride = size_of<T>();
  return it;
}

template <typename T>
typename Slice<T>::iterator Slice<T>::end() const noexcept {
  iterator it = this->begin();
  it.pos = static_cast<char *>(it.pos) + it.stride * this->size();
  return it;
}

template <typename T>
void Slice<T>::swap(Slice &rhs) noexcept {
  std::swap(*this, rhs);
}
#endif // CXXBRIDGE1_RUST_SLICE

#ifndef CXXBRIDGE1_RUST_BITCOPY_T
#define CXXBRIDGE1_RUST_BITCOPY_T
struct unsafe_bitcopy_t final {
  explicit unsafe_bitcopy_t() = default;
};
#endif // CXXBRIDGE1_RUST_BITCOPY_T

#ifndef CXXBRIDGE1_RUST_VEC
#define CXXBRIDGE1_RUST_VEC
template <typename T>
class Vec final {
public:
  using value_type = T;

  Vec() noexcept;
  Vec(std::initializer_list<T>);
  Vec(const Vec &);
  Vec(Vec &&) noexcept;
  ~Vec() noexcept;

  Vec &operator=(Vec &&) &noexcept;
  Vec &operator=(const Vec &) &;

  std::size_t size() const noexcept;
  bool empty() const noexcept;
  const T *data() const noexcept;
  T *data() noexcept;
  std::size_t capacity() const noexcept;

  const T &operator[](std::size_t n) const noexcept;
  const T &at(std::size_t n) const;
  const T &front() const noexcept;
  const T &back() const noexcept;

  T &operator[](std::size_t n) noexcept;
  T &at(std::size_t n);
  T &front() noexcept;
  T &back() noexcept;

  void reserve(std::size_t new_cap);
  void push_back(const T &value);
  void push_back(T &&value);
  template <typename... Args>
  void emplace_back(Args &&...args);
  void truncate(std::size_t len);
  void clear();

  using iterator = typename Slice<T>::iterator;
  iterator begin() noexcept;
  iterator end() noexcept;

  using const_iterator = typename Slice<const T>::iterator;
  const_iterator begin() const noexcept;
  const_iterator end() const noexcept;
  const_iterator cbegin() const noexcept;
  const_iterator cend() const noexcept;

  void swap(Vec &) noexcept;

  Vec(unsafe_bitcopy_t, const Vec &) noexcept;

private:
  void reserve_total(std::size_t new_cap) noexcept;
  void set_len(std::size_t len) noexcept;
  void drop() noexcept;

  friend void swap(Vec &lhs, Vec &rhs) noexcept { lhs.swap(rhs); }

  std::array<std::uintptr_t, 3> repr;
};

template <typename T>
Vec<T>::Vec(std::initializer_list<T> init) : Vec{} {
  this->reserve_total(init.size());
  std::move(init.begin(), init.end(), std::back_inserter(*this));
}

template <typename T>
Vec<T>::Vec(const Vec &other) : Vec() {
  this->reserve_total(other.size());
  std::copy(other.begin(), other.end(), std::back_inserter(*this));
}

template <typename T>
Vec<T>::Vec(Vec &&other) noexcept : repr(other.repr) {
  new (&other) Vec();
}

template <typename T>
Vec<T>::~Vec() noexcept {
  this->drop();
}

template <typename T>
Vec<T> &Vec<T>::operator=(Vec &&other) &noexcept {
  this->drop();
  this->repr = other.repr;
  new (&other) Vec();
  return *this;
}

template <typename T>
Vec<T> &Vec<T>::operator=(const Vec &other) & {
  if (this != &other) {
    this->drop();
    new (this) Vec(other);
  }
  return *this;
}

template <typename T>
bool Vec<T>::empty() const noexcept {
  return this->size() == 0;
}

template <typename T>
T *Vec<T>::data() noexcept {
  return const_cast<T *>(const_cast<const Vec<T> *>(this)->data());
}

template <typename T>
const T &Vec<T>::operator[](std::size_t n) const noexcept {
  assert(n < this->size());
  auto data = reinterpret_cast<const char *>(this->data());
  return *reinterpret_cast<const T *>(data + n * size_of<T>());
}

template <typename T>
const T &Vec<T>::at(std::size_t n) const {
  if (n >= this->size()) {
    panic<std::out_of_range>("rust::Vec index out of range");
  }
  return (*this)[n];
}

template <typename T>
const T &Vec<T>::front() const noexcept {
  assert(!this->empty());
  return (*this)[0];
}

template <typename T>
const T &Vec<T>::back() const noexcept {
  assert(!this->empty());
  return (*this)[this->size() - 1];
}

template <typename T>
T &Vec<T>::operator[](std::size_t n) noexcept {
  assert(n < this->size());
  auto data = reinterpret_cast<char *>(this->data());
  return *reinterpret_cast<T *>(data + n * size_of<T>());
}

template <typename T>
T &Vec<T>::at(std::size_t n) {
  if (n >= this->size()) {
    panic<std::out_of_range>("rust::Vec index out of range");
  }
  return (*this)[n];
}

template <typename T>
T &Vec<T>::front() noexcept {
  assert(!this->empty());
  return (*this)[0];
}

template <typename T>
T &Vec<T>::back() noexcept {
  assert(!this->empty());
  return (*this)[this->size() - 1];
}

template <typename T>
void Vec<T>::reserve(std::size_t new_cap) {
  this->reserve_total(new_cap);
}

template <typename T>
void Vec<T>::push_back(const T &value) {
  this->emplace_back(value);
}

template <typename T>
void Vec<T>::push_back(T &&value) {
  this->emplace_back(std::move(value));
}

template <typename T>
template <typename... Args>
void Vec<T>::emplace_back(Args &&...args) {
  auto size = this->size();
  this->reserve_total(size + 1);
  ::new (reinterpret_cast<T *>(reinterpret_cast<char *>(this->data()) +
                               size * size_of<T>()))
      T(std::forward<Args>(args)...);
  this->set_len(size + 1);
}

template <typename T>
void Vec<T>::clear() {
  this->truncate(0);
}

template <typename T>
typename Vec<T>::iterator Vec<T>::begin() noexcept {
  return Slice<T>(this->data(), this->size()).begin();
}

template <typename T>
typename Vec<T>::iterator Vec<T>::end() noexcept {
  return Slice<T>(this->data(), this->size()).end();
}

template <typename T>
typename Vec<T>::const_iterator Vec<T>::begin() const noexcept {
  return this->cbegin();
}

template <typename T>
typename Vec<T>::const_iterator Vec<T>::end() const noexcept {
  return this->cend();
}

template <typename T>
typename Vec<T>::const_iterator Vec<T>::cbegin() const noexcept {
  return Slice<const T>(this->data(), this->size()).begin();
}

template <typename T>
typename Vec<T>::const_iterator Vec<T>::cend() const noexcept {
  return Slice<const T>(this->data(), this->size()).end();
}

template <typename T>
void Vec<T>::swap(Vec &rhs) noexcept {
  using std::swap;
  swap(this->repr, rhs.repr);
}

template <typename T>
Vec<T>::Vec(unsafe_bitcopy_t, const Vec &bits) noexcept : repr(bits.repr) {}
#endif // CXXBRIDGE1_RUST_VEC

#ifndef CXXBRIDGE1_IS_COMPLETE
#define CXXBRIDGE1_IS_COMPLETE
namespace detail {
namespace {
template <typename T, typename = std::size_t>
struct is_complete : std::false_type {};
template <typename T>
struct is_complete<T, decltype(sizeof(T))> : std::true_type {};
} // namespace
} // namespace detail
#endif // CXXBRIDGE1_IS_COMPLETE

#ifndef CXXBRIDGE1_LAYOUT
#define CXXBRIDGE1_LAYOUT
class layout {
  template <typename T>
  friend std::size_t size_of();
  template <typename T>
  friend std::size_t align_of();
  template <typename T>
  static typename std::enable_if<std::is_base_of<Opaque, T>::value,
                                 std::size_t>::type
  do_size_of() {
    return T::layout::size();
  }
  template <typename T>
  static typename std::enable_if<!std::is_base_of<Opaque, T>::value,
                                 std::size_t>::type
  do_size_of() {
    return sizeof(T);
  }
  template <typename T>
  static
      typename std::enable_if<detail::is_complete<T>::value, std::size_t>::type
      size_of() {
    return do_size_of<T>();
  }
  template <typename T>
  static typename std::enable_if<std::is_base_of<Opaque, T>::value,
                                 std::size_t>::type
  do_align_of() {
    return T::layout::align();
  }
  template <typename T>
  static typename std::enable_if<!std::is_base_of<Opaque, T>::value,
                                 std::size_t>::type
  do_align_of() {
    return alignof(T);
  }
  template <typename T>
  static
      typename std::enable_if<detail::is_complete<T>::value, std::size_t>::type
      align_of() {
    return do_align_of<T>();
  }
};

template <typename T>
std::size_t size_of() {
  return layout::size_of<T>();
}

template <typename T>
std::size_t align_of() {
  return layout::align_of<T>();
}
#endif // CXXBRIDGE1_LAYOUT

#ifndef CXXBRIDGE1_RELOCATABLE
#define CXXBRIDGE1_RELOCATABLE
namespace detail {
template <typename... Ts>
struct make_void {
  using type = void;
};

template <typename... Ts>
using void_t = typename make_void<Ts...>::type;

template <typename Void, template <typename...> class, typename...>
struct detect : std::false_type {};
template <template <typename...> class T, typename... A>
struct detect<void_t<T<A...>>, T, A...> : std::true_type {};

template <template <typename...> class T, typename... A>
using is_detected = detect<void, T, A...>;

template <typename T>
using detect_IsRelocatable = typename T::IsRelocatable;

template <typename T>
struct get_IsRelocatable
    : std::is_same<typename T::IsRelocatable, std::true_type> {};
} // namespace detail

template <typename T>
struct IsRelocatable
    : std::conditional<
          detail::is_detected<detail::detect_IsRelocatable, T>::value,
          detail::get_IsRelocatable<T>,
          std::integral_constant<
              bool, std::is_trivially_move_constructible<T>::value &&
                        std::is_trivially_destructible<T>::value>>::type {};
#endif // CXXBRIDGE1_RELOCATABLE

namespace repr {
struct PtrLen final {
  void *ptr;
  ::std::size_t len;
};
} // namespace repr

namespace detail {
class Fail final {
  ::rust::repr::PtrLen &throw$;
public:
  Fail(::rust::repr::PtrLen &throw$) noexcept : throw$(throw$) {}
  void operator()(char const *) noexcept;
  void operator()(std::string const &) noexcept;
};
} // namespace detail

namespace {
template <typename T>
void destroy(T *ptr) {
  ptr->~T();
}

template <bool> struct deleter_if {
  template <typename T> void operator()(T *) {}
};

template <> struct deleter_if<true> {
  template <typename T> void operator()(T *ptr) { ptr->~T(); }
};
} // namespace
} // namespace cxxbridge1

namespace behavior {
class missing {};
missing trycatch(...);

template <typename Try, typename Fail>
static typename ::std::enable_if<
    ::std::is_same<decltype(trycatch(::std::declval<Try>(), ::std::declval<Fail>())),
                 missing>::value>::type
trycatch(Try &&func, Fail &&fail) noexcept try {
  func();
} catch (::std::exception const &e) {
  fail(e.what());
}
} // namespace behavior
} // namespace rust

namespace lbug {
  namespace common {
    using LogicalTypeID = ::lbug::common::LogicalTypeID;
    using PhysicalTypeID = ::lbug::common::PhysicalTypeID;
    using StatementType = ::lbug::common::StatementType;
    using LogicalType = ::lbug::common::LogicalType;
    using Value = ::lbug::common::Value;
  }
  namespace main {
    using PreparedStatement = ::lbug::main::PreparedStatement;
    using Database = ::lbug::main::Database;
    using Connection = ::lbug::main::Connection;
    using QueryResult = ::lbug::main::QueryResult;
  }
  namespace processor {
    using FlatTuple = ::lbug::processor::FlatTuple;
  }
}
namespace lbug_rs {
  using QueryParams = ::lbug_rs::QueryParams;
  using ValueListBuilder = ::lbug_rs::ValueListBuilder;
  using TypeListBuilder = ::lbug_rs::TypeListBuilder;
}

namespace lbug {
namespace common {
static_assert(::std::is_enum<LogicalTypeID>::value, "expected enum");
static_assert(sizeof(LogicalTypeID) == sizeof(::std::uint8_t), "incorrect size");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::ANY) == 0, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::NODE) == 10, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::REL) == 11, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::RECURSIVE_REL) == 12, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::SERIAL) == 13, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::BOOL) == 22, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::INT64) == 23, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::INT32) == 24, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::INT16) == 25, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::INT8) == 26, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::UINT64) == 27, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::UINT32) == 28, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::UINT16) == 29, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::UINT8) == 30, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::INT128) == 31, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::DOUBLE) == 32, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::FLOAT) == 33, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::DATE) == 34, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::TIMESTAMP) == 35, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::TIMESTAMP_SEC) == 36, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::TIMESTAMP_MS) == 37, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::TIMESTAMP_NS) == 38, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::TIMESTAMP_TZ) == 39, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::INTERVAL) == 40, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::DECIMAL) == 41, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::INTERNAL_ID) == 42, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::STRING) == 50, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::BLOB) == 51, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::LIST) == 52, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::ARRAY) == 53, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::STRUCT) == 54, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::MAP) == 55, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::UNION) == 56, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(LogicalTypeID::UUID) == 59, "disagrees with the value in #[cxx::bridge]");

static_assert(::std::is_enum<PhysicalTypeID>::value, "expected enum");
static_assert(sizeof(PhysicalTypeID) == sizeof(::std::uint8_t), "incorrect size");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::ANY) == 0, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::BOOL) == 1, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::INT64) == 2, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::INT32) == 3, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::INT16) == 4, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::INT8) == 5, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::UINT64) == 6, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::UINT32) == 7, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::UINT16) == 8, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::UINT8) == 9, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::INT128) == 10, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::DOUBLE) == 11, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::FLOAT) == 12, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::INTERVAL) == 13, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::INTERNAL_ID) == 14, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::STRING) == 20, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::LIST) == 22, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::ARRAY) == 23, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::STRUCT) == 24, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(PhysicalTypeID::POINTER) == 25, "disagrees with the value in #[cxx::bridge]");

static_assert(::std::is_enum<StatementType>::value, "expected enum");
static_assert(sizeof(StatementType) == sizeof(::std::uint8_t), "incorrect size");
static_assert(static_cast<::std::uint8_t>(StatementType::QUERY) == 0, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::CREATE_TABLE) == 1, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::DROP) == 2, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::ALTER) == 3, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::COPY_TO) == 19, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::COPY_FROM) == 20, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::STANDALONE_CALL) == 21, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::STANDALONE_CALL_FUNCTION) == 22, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::EXPLAIN) == 23, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::CREATE_MACRO) == 24, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::TRANSACTION) == 30, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::EXTENSION) == 31, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::EXPORT_DATABASE) == 32, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::IMPORT_DATABASE) == 33, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::ATTACH_DATABASE) == 34, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::DETACH_DATABASE) == 35, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::USE_DATABASE) == 36, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::CREATE_SEQUENCE) == 37, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::CREATE_TYPE) == 39, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::EXTENSION_CLAUSE) == 40, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::CREATE_GRAPH) == 41, "disagrees with the value in #[cxx::bridge]");
static_assert(static_cast<::std::uint8_t>(StatementType::USE_GRAPH) == 42, "disagrees with the value in #[cxx::bridge]");
} // namespace common
} // namespace lbug

static_assert(
    ::rust::IsRelocatable<::std::string_view>::value,
    "type std::string_view should be trivially move constructible and trivially destructible in C++ to be used as an argument of `new_database`, `connection_prepare`, `connection_query` or return value of `string_view_from_str` in Rust");

namespace lbug_rs {
extern "C" {
void lbug_rs$cxxbridge1$string_view_from_str(::rust::Str s, ::std::string_view *return$) noexcept {
  ::std::string_view (*string_view_from_str$)(::rust::Str) = ::lbug_rs::string_view_from_str;
  new (return$) ::std::string_view(string_view_from_str$(s));
}

bool lbug_rs$cxxbridge1$prepared_statement_is_success(::lbug::main::PreparedStatement const &statement) noexcept {
  bool (*prepared_statement_is_success$)(::lbug::main::PreparedStatement const &) = ::lbug_rs::prepared_statement_is_success;
  return prepared_statement_is_success$(statement);
}

void lbug_rs$cxxbridge1$prepared_statement_error_message(::lbug::main::PreparedStatement const &statement, ::rust::String *return$) noexcept {
  ::rust::String (*prepared_statement_error_message$)(::lbug::main::PreparedStatement const &) = ::lbug_rs::prepared_statement_error_message;
  new (return$) ::rust::String(prepared_statement_error_message$(statement));
}

::lbug::common::StatementType lbug_rs$cxxbridge1$prepared_statement_get_statement_type(::lbug::main::PreparedStatement const &statement) noexcept {
  ::lbug::common::StatementType (*prepared_statement_get_statement_type$)(::lbug::main::PreparedStatement const &) = ::lbug_rs::prepared_statement_get_statement_type;
  return prepared_statement_get_statement_type$(statement);
}

void lbug_rs$cxxbridge1$query_params_insert(::lbug_rs::QueryParams &params, ::rust::Str key, ::lbug::common::Value *value) noexcept {
  void (*query_params_insert$)(::lbug_rs::QueryParams &, ::rust::Str, ::std::unique_ptr<::lbug::common::Value>) = ::lbug_rs::query_params_insert;
  query_params_insert$(params, key, ::std::unique_ptr<::lbug::common::Value>(value));
}

::lbug_rs::QueryParams *lbug_rs$cxxbridge1$new_params() noexcept {
  ::std::unique_ptr<::lbug_rs::QueryParams> (*new_params$)() = ::lbug_rs::new_params;
  return new_params$().release();
}

::rust::repr::PtrLen lbug_rs$cxxbridge1$new_database(::std::string_view *databasePath, ::std::uint64_t bufferPoolSize, ::std::uint64_t maxNumThreads, bool enableCompression, bool readOnly, ::std::uint64_t maxDBSize, bool auto_checkpoint, ::std::int64_t checkpoint_threshold, bool throw_on_wal_replay_failure, bool enable_checksums, bool enableMultiWrites, ::lbug::main::Database **return$) noexcept {
  ::std::unique_ptr<::lbug::main::Database> (*new_database$)(::std::string_view, ::std::uint64_t, ::std::uint64_t, bool, bool, ::std::uint64_t, bool, ::std::int64_t, bool, bool, bool) = ::lbug_rs::new_database;
  ::rust::repr::PtrLen throw$;
  ::rust::behavior::trycatch(
      [&] {
        new (return$) ::lbug::main::Database *(new_database$(::std::move(*databasePath), bufferPoolSize, maxNumThreads, enableCompression, readOnly, maxDBSize, auto_checkpoint, checkpoint_threshold, throw_on_wal_replay_failure, enable_checksums, enableMultiWrites).release());
        throw$.ptr = nullptr;
      },
      ::rust::detail::Fail(throw$));
  return throw$;
}

::rust::repr::PtrLen lbug_rs$cxxbridge1$database_connect(::lbug::main::Database &database, ::lbug::main::Connection **return$) noexcept {
  ::std::unique_ptr<::lbug::main::Connection> (*database_connect$)(::lbug::main::Database &) = ::lbug_rs::database_connect;
  ::rust::repr::PtrLen throw$;
  ::rust::behavior::trycatch(
      [&] {
        new (return$) ::lbug::main::Connection *(database_connect$(database).release());
        throw$.ptr = nullptr;
      },
      ::rust::detail::Fail(throw$));
  return throw$;
}

::rust::repr::PtrLen lbug_rs$cxxbridge1$connection_prepare(::lbug::main::Connection &connection, ::std::string_view *query, ::lbug::main::PreparedStatement **return$) noexcept {
  ::std::unique_ptr<::lbug::main::PreparedStatement> (*connection_prepare$)(::lbug::main::Connection &, ::std::string_view) = ::lbug_rs::connection_prepare;
  ::rust::repr::PtrLen throw$;
  ::rust::behavior::trycatch(
      [&] {
        new (return$) ::lbug::main::PreparedStatement *(connection_prepare$(connection, ::std::move(*query)).release());
        throw$.ptr = nullptr;
      },
      ::rust::detail::Fail(throw$));
  return throw$;
}

::rust::repr::PtrLen lbug_rs$cxxbridge1$connection_execute(::lbug::main::Connection &connection, ::lbug::main::PreparedStatement &query, ::lbug_rs::QueryParams *params, ::lbug::main::QueryResult **return$) noexcept {
  ::std::unique_ptr<::lbug::main::QueryResult> (*connection_execute$)(::lbug::main::Connection &, ::lbug::main::PreparedStatement &, ::std::unique_ptr<::lbug_rs::QueryParams>) = ::lbug_rs::connection_execute;
  ::rust::repr::PtrLen throw$;
  ::rust::behavior::trycatch(
      [&] {
        new (return$) ::lbug::main::QueryResult *(connection_execute$(connection, query, ::std::unique_ptr<::lbug_rs::QueryParams>(params)).release());
        throw$.ptr = nullptr;
      },
      ::rust::detail::Fail(throw$));
  return throw$;
}

::rust::repr::PtrLen lbug_rs$cxxbridge1$connection_query(::lbug::main::Connection &connection, ::std::string_view *query, ::lbug::main::QueryResult **return$) noexcept {
  ::std::unique_ptr<::lbug::main::QueryResult> (*connection_query$)(::lbug::main::Connection &, ::std::string_view) = ::lbug_rs::connection_query;
  ::rust::repr::PtrLen throw$;
  ::rust::behavior::trycatch(
      [&] {
        new (return$) ::lbug::main::QueryResult *(connection_query$(connection, ::std::move(*query)).release());
        throw$.ptr = nullptr;
      },
      ::rust::detail::Fail(throw$));
  return throw$;
}

::std::uint64_t lbug_rs$cxxbridge1$connection_get_max_num_thread_for_exec(::lbug::main::Connection &connection) noexcept {
  ::std::uint64_t (*connection_get_max_num_thread_for_exec$)(::lbug::main::Connection &) = ::lbug_rs::connection_get_max_num_thread_for_exec;
  return connection_get_max_num_thread_for_exec$(connection);
}

void lbug_rs$cxxbridge1$connection_set_max_num_thread_for_exec(::lbug::main::Connection &connection, ::std::uint64_t num_threads) noexcept {
  void (*connection_set_max_num_thread_for_exec$)(::lbug::main::Connection &, ::std::uint64_t) = ::lbug_rs::connection_set_max_num_thread_for_exec;
  connection_set_max_num_thread_for_exec$(connection, num_threads);
}

::rust::repr::PtrLen lbug_rs$cxxbridge1$connection_interrupt(::lbug::main::Connection &connection) noexcept {
  void (*connection_interrupt$)(::lbug::main::Connection &) = ::lbug_rs::connection_interrupt;
  ::rust::repr::PtrLen throw$;
  ::rust::behavior::trycatch(
      [&] {
        connection_interrupt$(connection);
        throw$.ptr = nullptr;
      },
      ::rust::detail::Fail(throw$));
  return throw$;
}

void lbug_rs$cxxbridge1$connection_set_query_timeout(::lbug::main::Connection &connection, ::std::uint64_t timeout_ms) noexcept {
  void (*connection_set_query_timeout$)(::lbug::main::Connection &, ::std::uint64_t) = ::lbug_rs::connection_set_query_timeout;
  connection_set_query_timeout$(connection, timeout_ms);
}

void lbug_rs$cxxbridge1$query_result_to_string(::lbug::main::QueryResult const &query_result, ::rust::String *return$) noexcept {
  ::rust::String (*query_result_to_string$)(::lbug::main::QueryResult const &) = ::lbug_rs::query_result_to_string;
  new (return$) ::rust::String(query_result_to_string$(query_result));
}

bool lbug_rs$cxxbridge1$query_result_is_success(::lbug::main::QueryResult const &query_result) noexcept {
  bool (*query_result_is_success$)(::lbug::main::QueryResult const &) = ::lbug_rs::query_result_is_success;
  return query_result_is_success$(query_result);
}

void lbug_rs$cxxbridge1$query_result_get_error_message(::lbug::main::QueryResult const &query_result, ::rust::String *return$) noexcept {
  ::rust::String (*query_result_get_error_message$)(::lbug::main::QueryResult const &) = ::lbug_rs::query_result_get_error_message;
  new (return$) ::rust::String(query_result_get_error_message$(query_result));
}

bool lbug_rs$cxxbridge1$query_result_has_next(::lbug::main::QueryResult const &query_result) noexcept {
  bool (*query_result_has_next$)(::lbug::main::QueryResult const &) = ::lbug_rs::query_result_has_next;
  return query_result_has_next$(query_result);
}

void lbug_rs$cxxbridge1$query_result_get_next(::lbug::main::QueryResult &query_result, ::std::shared_ptr<::lbug::processor::FlatTuple> *return$) noexcept {
  ::std::shared_ptr<::lbug::processor::FlatTuple> (*query_result_get_next$)(::lbug::main::QueryResult &) = ::lbug_rs::query_result_get_next;
  new (return$) ::std::shared_ptr<::lbug::processor::FlatTuple>(query_result_get_next$(query_result));
}

double lbug_rs$cxxbridge1$query_result_get_compiling_time(::lbug::main::QueryResult const &result) noexcept {
  double (*query_result_get_compiling_time$)(::lbug::main::QueryResult const &) = ::lbug_rs::query_result_get_compiling_time;
  return query_result_get_compiling_time$(result);
}

double lbug_rs$cxxbridge1$query_result_get_execution_time(::lbug::main::QueryResult const &result) noexcept {
  double (*query_result_get_execution_time$)(::lbug::main::QueryResult const &) = ::lbug_rs::query_result_get_execution_time;
  return query_result_get_execution_time$(result);
}

::std::size_t lbug_rs$cxxbridge1$query_result_get_num_columns(::lbug::main::QueryResult const &result) noexcept {
  ::std::size_t (*query_result_get_num_columns$)(::lbug::main::QueryResult const &) = ::lbug_rs::query_result_get_num_columns;
  return query_result_get_num_columns$(result);
}

::std::uint64_t lbug_rs$cxxbridge1$query_result_get_num_tuples(::lbug::main::QueryResult const &result) noexcept {
  ::std::uint64_t (*query_result_get_num_tuples$)(::lbug::main::QueryResult const &) = ::lbug_rs::query_result_get_num_tuples;
  return query_result_get_num_tuples$(result);
}

::std::vector<::lbug::common::LogicalType> *lbug_rs$cxxbridge1$query_result_column_data_types(::lbug::main::QueryResult const &query_result) noexcept {
  ::std::unique_ptr<::std::vector<::lbug::common::LogicalType>> (*query_result_column_data_types$)(::lbug::main::QueryResult const &) = ::lbug_rs::query_result_column_data_types;
  return query_result_column_data_types$(query_result).release();
}

void lbug_rs$cxxbridge1$query_result_column_names(::lbug::main::QueryResult const &query_result, ::rust::Vec<::rust::String> *return$) noexcept {
  ::rust::Vec<::rust::String> (*query_result_column_names$)(::lbug::main::QueryResult const &) = ::lbug_rs::query_result_column_names;
  new (return$) ::rust::Vec<::rust::String>(query_result_column_names$(query_result));
}

::std::uint32_t lbug_rs$cxxbridge1$flat_tuple_len(::lbug::processor::FlatTuple const &tuple) noexcept {
  ::std::uint32_t (*flat_tuple_len$)(::lbug::processor::FlatTuple const &) = ::lbug_rs::flat_tuple_len;
  return flat_tuple_len$(tuple);
}

::lbug::common::Value const *lbug_rs$cxxbridge1$flat_tuple_get_value(::lbug::processor::FlatTuple const &tuple, ::std::uint32_t index) noexcept {
  ::lbug::common::Value const &(*flat_tuple_get_value$)(::lbug::processor::FlatTuple const &, ::std::uint32_t) = ::lbug_rs::flat_tuple_get_value;
  return &flat_tuple_get_value$(tuple, index);
}

::lbug::common::LogicalType *lbug_rs$cxxbridge1$create_logical_type(::lbug::common::LogicalTypeID id) noexcept {
  ::std::unique_ptr<::lbug::common::LogicalType> (*create_logical_type$)(::lbug::common::LogicalTypeID) = ::lbug_rs::create_logical_type;
  return create_logical_type$(id).release();
}

::lbug::common::LogicalType *lbug_rs$cxxbridge1$create_logical_type_list(::lbug::common::LogicalType *child_type) noexcept {
  ::std::unique_ptr<::lbug::common::LogicalType> (*create_logical_type_list$)(::std::unique_ptr<::lbug::common::LogicalType>) = ::lbug_rs::create_logical_type_list;
  return create_logical_type_list$(::std::unique_ptr<::lbug::common::LogicalType>(child_type)).release();
}

::lbug::common::LogicalType *lbug_rs$cxxbridge1$create_logical_type_decimal(::std::uint32_t precision, ::std::uint32_t scale) noexcept {
  ::std::unique_ptr<::lbug::common::LogicalType> (*create_logical_type_decimal$)(::std::uint32_t, ::std::uint32_t) = ::lbug_rs::create_logical_type_decimal;
  return create_logical_type_decimal$(precision, scale).release();
}

::lbug::common::LogicalType *lbug_rs$cxxbridge1$create_logical_type_array(::lbug::common::LogicalType *child_type, ::std::uint64_t num_elements) noexcept {
  ::std::unique_ptr<::lbug::common::LogicalType> (*create_logical_type_array$)(::std::unique_ptr<::lbug::common::LogicalType>, ::std::uint64_t) = ::lbug_rs::create_logical_type_array;
  return create_logical_type_array$(::std::unique_ptr<::lbug::common::LogicalType>(child_type), num_elements).release();
}

::lbug::common::LogicalType *lbug_rs$cxxbridge1$create_logical_type_struct(::rust::Vec<::rust::String> const &field_names, ::lbug_rs::TypeListBuilder *types) noexcept {
  ::std::unique_ptr<::lbug::common::LogicalType> (*create_logical_type_struct$)(::rust::Vec<::rust::String> const &, ::std::unique_ptr<::lbug_rs::TypeListBuilder>) = ::lbug_rs::create_logical_type_struct;
  return create_logical_type_struct$(field_names, ::std::unique_ptr<::lbug_rs::TypeListBuilder>(types)).release();
}

::lbug::common::LogicalType *lbug_rs$cxxbridge1$create_logical_type_union(::rust::Vec<::rust::String> const &field_names, ::lbug_rs::TypeListBuilder *types) noexcept {
  ::std::unique_ptr<::lbug::common::LogicalType> (*create_logical_type_union$)(::rust::Vec<::rust::String> const &, ::std::unique_ptr<::lbug_rs::TypeListBuilder>) = ::lbug_rs::create_logical_type_union;
  return create_logical_type_union$(field_names, ::std::unique_ptr<::lbug_rs::TypeListBuilder>(types)).release();
}

::lbug::common::LogicalType *lbug_rs$cxxbridge1$create_logical_type_map(::lbug::common::LogicalType *keyType, ::lbug::common::LogicalType *valueType) noexcept {
  ::std::unique_ptr<::lbug::common::LogicalType> (*create_logical_type_map$)(::std::unique_ptr<::lbug::common::LogicalType>, ::std::unique_ptr<::lbug::common::LogicalType>) = ::lbug_rs::create_logical_type_map;
  return create_logical_type_map$(::std::unique_ptr<::lbug::common::LogicalType>(keyType), ::std::unique_ptr<::lbug::common::LogicalType>(valueType)).release();
}

::lbug::common::LogicalType *lbug_rs$cxxbridge1$logical_type_get_list_child_type(::lbug::common::LogicalType const &value) noexcept {
  ::std::unique_ptr<::lbug::common::LogicalType> (*logical_type_get_list_child_type$)(::lbug::common::LogicalType const &) = ::lbug_rs::logical_type_get_list_child_type;
  return logical_type_get_list_child_type$(value).release();
}

::lbug::common::LogicalType *lbug_rs$cxxbridge1$logical_type_get_array_child_type(::lbug::common::LogicalType const &value) noexcept {
  ::std::unique_ptr<::lbug::common::LogicalType> (*logical_type_get_array_child_type$)(::lbug::common::LogicalType const &) = ::lbug_rs::logical_type_get_array_child_type;
  return logical_type_get_array_child_type$(value).release();
}

::std::uint64_t lbug_rs$cxxbridge1$logical_type_get_array_num_elements(::lbug::common::LogicalType const &value) noexcept {
  ::std::uint64_t (*logical_type_get_array_num_elements$)(::lbug::common::LogicalType const &) = ::lbug_rs::logical_type_get_array_num_elements;
  return logical_type_get_array_num_elements$(value);
}

void lbug_rs$cxxbridge1$logical_type_get_struct_field_names(::lbug::common::LogicalType const &value, ::rust::Vec<::rust::String> *return$) noexcept {
  ::rust::Vec<::rust::String> (*logical_type_get_struct_field_names$)(::lbug::common::LogicalType const &) = ::lbug_rs::logical_type_get_struct_field_names;
  new (return$) ::rust::Vec<::rust::String>(logical_type_get_struct_field_names$(value));
}

::std::vector<::lbug::common::LogicalType> *lbug_rs$cxxbridge1$logical_type_get_struct_field_types(::lbug::common::LogicalType const &value) noexcept {
  ::std::unique_ptr<::std::vector<::lbug::common::LogicalType>> (*logical_type_get_struct_field_types$)(::lbug::common::LogicalType const &) = ::lbug_rs::logical_type_get_struct_field_types;
  return logical_type_get_struct_field_types$(value).release();
}

::std::uint32_t lbug_rs$cxxbridge1$logical_type_get_decimal_precision(::lbug::common::LogicalType const &value) noexcept {
  ::std::uint32_t (*logical_type_get_decimal_precision$)(::lbug::common::LogicalType const &) = ::lbug_rs::logical_type_get_decimal_precision;
  return logical_type_get_decimal_precision$(value);
}

::std::uint32_t lbug_rs$cxxbridge1$logical_type_get_decimal_scale(::lbug::common::LogicalType const &value) noexcept {
  ::std::uint32_t (*logical_type_get_decimal_scale$)(::lbug::common::LogicalType const &) = ::lbug_rs::logical_type_get_decimal_scale;
  return logical_type_get_decimal_scale$(value);
}

::lbug::common::LogicalTypeID lbug_rs$cxxbridge1$logical_type_get_logical_type_id(::lbug::common::LogicalType const &value) noexcept {
  ::lbug::common::LogicalTypeID (*logical_type_get_logical_type_id$)(::lbug::common::LogicalType const &) = ::lbug_rs::logical_type_get_logical_type_id;
  return logical_type_get_logical_type_id$(value);
}

void lbug_rs$cxxbridge1$value_list_insert(::lbug_rs::ValueListBuilder &value_list, ::lbug::common::Value *value) noexcept {
  void (*value_list_insert$)(::lbug_rs::ValueListBuilder &, ::std::unique_ptr<::lbug::common::Value>) = ::lbug_rs::value_list_insert;
  value_list_insert$(value_list, ::std::unique_ptr<::lbug::common::Value>(value));
}

::lbug::common::Value *lbug_rs$cxxbridge1$get_list_value(::lbug::common::LogicalType *typ, ::lbug_rs::ValueListBuilder *value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*get_list_value$)(::std::unique_ptr<::lbug::common::LogicalType>, ::std::unique_ptr<::lbug_rs::ValueListBuilder>) = ::lbug_rs::get_list_value;
  return get_list_value$(::std::unique_ptr<::lbug::common::LogicalType>(typ), ::std::unique_ptr<::lbug_rs::ValueListBuilder>(value)).release();
}

::lbug_rs::ValueListBuilder *lbug_rs$cxxbridge1$create_list() noexcept {
  ::std::unique_ptr<::lbug_rs::ValueListBuilder> (*create_list$)() = ::lbug_rs::create_list;
  return create_list$().release();
}

void lbug_rs$cxxbridge1$type_list_insert(::lbug_rs::TypeListBuilder &type_list, ::lbug::common::LogicalType *typ) noexcept {
  void (*type_list_insert$)(::lbug_rs::TypeListBuilder &, ::std::unique_ptr<::lbug::common::LogicalType>) = ::lbug_rs::type_list_insert;
  type_list_insert$(type_list, ::std::unique_ptr<::lbug::common::LogicalType>(typ));
}

::lbug_rs::TypeListBuilder *lbug_rs$cxxbridge1$create_type_list() noexcept {
  ::std::unique_ptr<::lbug_rs::TypeListBuilder> (*create_type_list$)() = ::lbug_rs::create_type_list;
  return create_type_list$().release();
}

void lbug_rs$cxxbridge1$value_to_string(::lbug::common::Value const &node_value, ::rust::String *return$) noexcept {
  ::rust::String (*value_to_string$)(::lbug::common::Value const &) = ::lbug_rs::value_to_string;
  new (return$) ::rust::String(value_to_string$(node_value));
}

bool lbug_rs$cxxbridge1$value_get_bool(::lbug::common::Value const &value) noexcept {
  bool (*value_get_bool$)(::lbug::common::Value const &) = ::lbug_rs::value_get_bool;
  return value_get_bool$(value);
}

::std::int8_t lbug_rs$cxxbridge1$value_get_i8(::lbug::common::Value const &value) noexcept {
  ::std::int8_t (*value_get_i8$)(::lbug::common::Value const &) = ::lbug_rs::value_get_i8;
  return value_get_i8$(value);
}

::std::int16_t lbug_rs$cxxbridge1$value_get_i16(::lbug::common::Value const &value) noexcept {
  ::std::int16_t (*value_get_i16$)(::lbug::common::Value const &) = ::lbug_rs::value_get_i16;
  return value_get_i16$(value);
}

::std::int32_t lbug_rs$cxxbridge1$value_get_i32(::lbug::common::Value const &value) noexcept {
  ::std::int32_t (*value_get_i32$)(::lbug::common::Value const &) = ::lbug_rs::value_get_i32;
  return value_get_i32$(value);
}

::std::int64_t lbug_rs$cxxbridge1$value_get_i64(::lbug::common::Value const &value) noexcept {
  ::std::int64_t (*value_get_i64$)(::lbug::common::Value const &) = ::lbug_rs::value_get_i64;
  return value_get_i64$(value);
}

::std::uint8_t lbug_rs$cxxbridge1$value_get_u8(::lbug::common::Value const &value) noexcept {
  ::std::uint8_t (*value_get_u8$)(::lbug::common::Value const &) = ::lbug_rs::value_get_u8;
  return value_get_u8$(value);
}

::std::uint16_t lbug_rs$cxxbridge1$value_get_u16(::lbug::common::Value const &value) noexcept {
  ::std::uint16_t (*value_get_u16$)(::lbug::common::Value const &) = ::lbug_rs::value_get_u16;
  return value_get_u16$(value);
}

::std::uint32_t lbug_rs$cxxbridge1$value_get_u32(::lbug::common::Value const &value) noexcept {
  ::std::uint32_t (*value_get_u32$)(::lbug::common::Value const &) = ::lbug_rs::value_get_u32;
  return value_get_u32$(value);
}

::std::uint64_t lbug_rs$cxxbridge1$value_get_u64(::lbug::common::Value const &value) noexcept {
  ::std::uint64_t (*value_get_u64$)(::lbug::common::Value const &) = ::lbug_rs::value_get_u64;
  return value_get_u64$(value);
}

float lbug_rs$cxxbridge1$value_get_float(::lbug::common::Value const &value) noexcept {
  float (*value_get_float$)(::lbug::common::Value const &) = ::lbug_rs::value_get_float;
  return value_get_float$(value);
}

double lbug_rs$cxxbridge1$value_get_double(::lbug::common::Value const &value) noexcept {
  double (*value_get_double$)(::lbug::common::Value const &) = ::lbug_rs::value_get_double;
  return value_get_double$(value);
}

::std::string const *lbug_rs$cxxbridge1$value_get_string(::lbug::common::Value const &value) noexcept {
  ::std::string const &(*value_get_string$)(::lbug::common::Value const &) = ::lbug_rs::value_get_string;
  return &value_get_string$(value);
}

::std::int64_t lbug_rs$cxxbridge1$value_get_interval_secs(::lbug::common::Value const &value) noexcept {
  ::std::int64_t (*value_get_interval_secs$)(::lbug::common::Value const &) = ::lbug_rs::value_get_interval_secs;
  return value_get_interval_secs$(value);
}

::std::int32_t lbug_rs$cxxbridge1$value_get_interval_micros(::lbug::common::Value const &value) noexcept {
  ::std::int32_t (*value_get_interval_micros$)(::lbug::common::Value const &) = ::lbug_rs::value_get_interval_micros;
  return value_get_interval_micros$(value);
}

::std::int64_t lbug_rs$cxxbridge1$value_get_timestamp_micros(::lbug::common::Value const &value) noexcept {
  ::std::int64_t (*value_get_timestamp_micros$)(::lbug::common::Value const &) = ::lbug_rs::value_get_timestamp_micros;
  return value_get_timestamp_micros$(value);
}

::std::int64_t lbug_rs$cxxbridge1$value_get_timestamp_ns(::lbug::common::Value const &value) noexcept {
  ::std::int64_t (*value_get_timestamp_ns$)(::lbug::common::Value const &) = ::lbug_rs::value_get_timestamp_ns;
  return value_get_timestamp_ns$(value);
}

::std::int64_t lbug_rs$cxxbridge1$value_get_timestamp_ms(::lbug::common::Value const &value) noexcept {
  ::std::int64_t (*value_get_timestamp_ms$)(::lbug::common::Value const &) = ::lbug_rs::value_get_timestamp_ms;
  return value_get_timestamp_ms$(value);
}

::std::int64_t lbug_rs$cxxbridge1$value_get_timestamp_sec(::lbug::common::Value const &value) noexcept {
  ::std::int64_t (*value_get_timestamp_sec$)(::lbug::common::Value const &) = ::lbug_rs::value_get_timestamp_sec;
  return value_get_timestamp_sec$(value);
}

::std::int64_t lbug_rs$cxxbridge1$value_get_timestamp_tz(::lbug::common::Value const &value) noexcept {
  ::std::int64_t (*value_get_timestamp_tz$)(::lbug::common::Value const &) = ::lbug_rs::value_get_timestamp_tz;
  return value_get_timestamp_tz$(value);
}

::std::int32_t lbug_rs$cxxbridge1$value_get_date_days(::lbug::common::Value const &value) noexcept {
  ::std::int32_t (*value_get_date_days$)(::lbug::common::Value const &) = ::lbug_rs::value_get_date_days;
  return value_get_date_days$(value);
}

void lbug_rs$cxxbridge1$value_get_int128_t(::lbug::common::Value const &value, ::std::array<::std::uint64_t, 2> *return$) noexcept {
  ::std::array<::std::uint64_t, 2> (*value_get_int128_t$)(::lbug::common::Value const &) = ::lbug_rs::value_get_int128_t;
  new (return$) ::std::array<::std::uint64_t, 2>(value_get_int128_t$(value));
}

void lbug_rs$cxxbridge1$value_get_internal_id(::lbug::common::Value const &value, ::std::array<::std::uint64_t, 2> *return$) noexcept {
  ::std::array<::std::uint64_t, 2> (*value_get_internal_id$)(::lbug::common::Value const &) = ::lbug_rs::value_get_internal_id;
  new (return$) ::std::array<::std::uint64_t, 2>(value_get_internal_id$(value));
}

::lbug::common::LogicalTypeID lbug_rs$cxxbridge1$value_get_data_type_id(::lbug::common::Value const &value) noexcept {
  ::lbug::common::LogicalTypeID (*value_get_data_type_id$)(::lbug::common::Value const &) = ::lbug_rs::value_get_data_type_id;
  return value_get_data_type_id$(value);
}

::lbug::common::LogicalType const *lbug_rs$cxxbridge1$value_get_data_type(::lbug::common::Value const &value) noexcept {
  ::lbug::common::LogicalType const &(*value_get_data_type$)(::lbug::common::Value const &) = ::lbug_rs::value_get_data_type;
  return &value_get_data_type$(value);
}

::lbug::common::PhysicalTypeID lbug_rs$cxxbridge1$value_get_physical_type(::lbug::common::Value const &value) noexcept {
  ::lbug::common::PhysicalTypeID (*value_get_physical_type$)(::lbug::common::Value const &) = ::lbug_rs::value_get_physical_type;
  return value_get_physical_type$(value);
}

::std::uint32_t lbug_rs$cxxbridge1$value_get_children_size(::lbug::common::Value const &value) noexcept {
  ::std::uint32_t (*value_get_children_size$)(::lbug::common::Value const &) = ::lbug_rs::value_get_children_size;
  return value_get_children_size$(value);
}

::lbug::common::Value const *lbug_rs$cxxbridge1$value_get_child(::lbug::common::Value const &value, ::std::uint32_t index) noexcept {
  ::lbug::common::Value const &(*value_get_child$)(::lbug::common::Value const &, ::std::uint32_t) = ::lbug_rs::value_get_child;
  return &value_get_child$(value, index);
}

bool lbug_rs$cxxbridge1$value_is_null(::lbug::common::Value const &value) noexcept {
  bool (*value_is_null$)(::lbug::common::Value const &) = ::lbug_rs::value_is_null;
  return value_is_null$(value);
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_bool(bool value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_bool$)(bool) = ::lbug_rs::create_value;
  return create_value_bool$(value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_i8(::std::int8_t value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_i8$)(::std::int8_t) = ::lbug_rs::create_value;
  return create_value_i8$(value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_i16(::std::int16_t value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_i16$)(::std::int16_t) = ::lbug_rs::create_value;
  return create_value_i16$(value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_i32(::std::int32_t value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_i32$)(::std::int32_t) = ::lbug_rs::create_value;
  return create_value_i32$(value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_i64(::std::int64_t value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_i64$)(::std::int64_t) = ::lbug_rs::create_value;
  return create_value_i64$(value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_u8(::std::uint8_t value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_u8$)(::std::uint8_t) = ::lbug_rs::create_value;
  return create_value_u8$(value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_u16(::std::uint16_t value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_u16$)(::std::uint16_t) = ::lbug_rs::create_value;
  return create_value_u16$(value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_u32(::std::uint32_t value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_u32$)(::std::uint32_t) = ::lbug_rs::create_value;
  return create_value_u32$(value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_u64(::std::uint64_t value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_u64$)(::std::uint64_t) = ::lbug_rs::create_value;
  return create_value_u64$(value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_float(float value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_float$)(float) = ::lbug_rs::create_value;
  return create_value_float$(value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_double(double value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_double$)(double) = ::lbug_rs::create_value;
  return create_value_double$(value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_null(::lbug::common::LogicalType *typ) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_null$)(::std::unique_ptr<::lbug::common::LogicalType>) = ::lbug_rs::create_value_null;
  return create_value_null$(::std::unique_ptr<::lbug::common::LogicalType>(typ)).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_string(::lbug::common::LogicalTypeID typ, ::rust::Slice<::std::uint8_t const> value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_string$)(::lbug::common::LogicalTypeID, ::rust::Slice<::std::uint8_t const>) = ::lbug_rs::create_value_string;
  return create_value_string$(typ, value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_timestamp(::std::int64_t value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_timestamp$)(::std::int64_t) = ::lbug_rs::create_value_timestamp;
  return create_value_timestamp$(value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_timestamp_tz(::std::int64_t value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_timestamp_tz$)(::std::int64_t) = ::lbug_rs::create_value_timestamp_tz;
  return create_value_timestamp_tz$(value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_timestamp_ns(::std::int64_t value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_timestamp_ns$)(::std::int64_t) = ::lbug_rs::create_value_timestamp_ns;
  return create_value_timestamp_ns$(value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_timestamp_ms(::std::int64_t value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_timestamp_ms$)(::std::int64_t) = ::lbug_rs::create_value_timestamp_ms;
  return create_value_timestamp_ms$(value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_timestamp_sec(::std::int64_t value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_timestamp_sec$)(::std::int64_t) = ::lbug_rs::create_value_timestamp_sec;
  return create_value_timestamp_sec$(value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_date(::std::int32_t value) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_date$)(::std::int32_t) = ::lbug_rs::create_value_date;
  return create_value_date$(value).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_interval(::std::int32_t months, ::std::int32_t days, ::std::int64_t micros) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_interval$)(::std::int32_t, ::std::int32_t, ::std::int64_t) = ::lbug_rs::create_value_interval;
  return create_value_interval$(months, days, micros).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_int128_t(::std::int64_t high, ::std::uint64_t low) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_int128_t$)(::std::int64_t, ::std::uint64_t) = ::lbug_rs::create_value_int128_t;
  return create_value_int128_t$(high, low).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_uuid_t(::std::int64_t high, ::std::uint64_t low) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_uuid_t$)(::std::int64_t, ::std::uint64_t) = ::lbug_rs::create_value_uuid_t;
  return create_value_uuid_t$(high, low).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_internal_id(::std::uint64_t offset, ::std::uint64_t table) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_internal_id$)(::std::uint64_t, ::std::uint64_t) = ::lbug_rs::create_value_internal_id;
  return create_value_internal_id$(offset, table).release();
}

::lbug::common::Value *lbug_rs$cxxbridge1$create_value_decimal(::std::int64_t high, ::std::uint64_t low, ::std::uint32_t scale, ::std::uint32_t precision) noexcept {
  ::std::unique_ptr<::lbug::common::Value> (*create_value_decimal$)(::std::int64_t, ::std::uint64_t, ::std::uint32_t, ::std::uint32_t) = ::lbug_rs::create_value_decimal;
  return create_value_decimal$(high, low, scale, precision).release();
}

::lbug::common::Value const *lbug_rs$cxxbridge1$node_value_get_node_id(::lbug::common::Value const &value) noexcept {
  ::lbug::common::Value const &(*node_value_get_node_id$)(::lbug::common::Value const &) = ::lbug_rs::node_value_get_node_id;
  return &node_value_get_node_id$(value);
}

void lbug_rs$cxxbridge1$node_value_get_label_name(::lbug::common::Value const &value, ::rust::String *return$) noexcept {
  ::rust::String (*node_value_get_label_name$)(::lbug::common::Value const &) = ::lbug_rs::node_value_get_label_name;
  new (return$) ::rust::String(node_value_get_label_name$(value));
}

::std::size_t lbug_rs$cxxbridge1$node_value_get_num_properties(::lbug::common::Value const &value) noexcept {
  ::std::size_t (*node_value_get_num_properties$)(::lbug::common::Value const &) = ::lbug_rs::node_value_get_num_properties;
  return node_value_get_num_properties$(value);
}

void lbug_rs$cxxbridge1$node_value_get_property_name(::lbug::common::Value const &value, ::std::size_t index, ::rust::String *return$) noexcept {
  ::rust::String (*node_value_get_property_name$)(::lbug::common::Value const &, ::std::size_t) = ::lbug_rs::node_value_get_property_name;
  new (return$) ::rust::String(node_value_get_property_name$(value, index));
}

::lbug::common::Value const *lbug_rs$cxxbridge1$node_value_get_property_value(::lbug::common::Value const &value, ::std::size_t index) noexcept {
  ::lbug::common::Value const &(*node_value_get_property_value$)(::lbug::common::Value const &, ::std::size_t) = ::lbug_rs::node_value_get_property_value;
  return &node_value_get_property_value$(value, index);
}

void lbug_rs$cxxbridge1$rel_value_get_label_name(::lbug::common::Value const &value, ::rust::String *return$) noexcept {
  ::rust::String (*rel_value_get_label_name$)(::lbug::common::Value const &) = ::lbug_rs::rel_value_get_label_name;
  new (return$) ::rust::String(rel_value_get_label_name$(value));
}

::lbug::common::Value const *lbug_rs$cxxbridge1$rel_value_get_src_id(::lbug::common::Value const &value) noexcept {
  ::lbug::common::Value const &(*rel_value_get_src_id$)(::lbug::common::Value const &) = ::lbug_rs::rel_value_get_src_id;
  return &rel_value_get_src_id$(value);
}

void lbug_rs$cxxbridge1$rel_value_get_dst_id(::lbug::common::Value const &value, ::std::array<::std::uint64_t, 2> *return$) noexcept {
  ::std::array<::std::uint64_t, 2> (*rel_value_get_dst_id$)(::lbug::common::Value const &) = ::lbug_rs::rel_value_get_dst_id;
  new (return$) ::std::array<::std::uint64_t, 2>(rel_value_get_dst_id$(value));
}

::std::size_t lbug_rs$cxxbridge1$rel_value_get_num_properties(::lbug::common::Value const &value) noexcept {
  ::std::size_t (*rel_value_get_num_properties$)(::lbug::common::Value const &) = ::lbug_rs::rel_value_get_num_properties;
  return rel_value_get_num_properties$(value);
}

void lbug_rs$cxxbridge1$rel_value_get_property_name(::lbug::common::Value const &value, ::std::size_t index, ::rust::String *return$) noexcept {
  ::rust::String (*rel_value_get_property_name$)(::lbug::common::Value const &, ::std::size_t) = ::lbug_rs::rel_value_get_property_name;
  new (return$) ::rust::String(rel_value_get_property_name$(value, index));
}

::lbug::common::Value const *lbug_rs$cxxbridge1$rel_value_get_property_value(::lbug::common::Value const &value, ::std::size_t index) noexcept {
  ::lbug::common::Value const &(*rel_value_get_property_value$)(::lbug::common::Value const &, ::std::size_t) = ::lbug_rs::rel_value_get_property_value;
  return &rel_value_get_property_value$(value, index);
}

::lbug::common::Value const *lbug_rs$cxxbridge1$recursive_rel_get_nodes(::lbug::common::Value const &value) noexcept {
  ::lbug::common::Value const &(*recursive_rel_get_nodes$)(::lbug::common::Value const &) = ::lbug_rs::recursive_rel_get_nodes;
  return &recursive_rel_get_nodes$(value);
}

::lbug::common::Value const *lbug_rs$cxxbridge1$recursive_rel_get_rels(::lbug::common::Value const &value) noexcept {
  ::lbug::common::Value const &(*recursive_rel_get_rels$)(::lbug::common::Value const &) = ::lbug_rs::recursive_rel_get_rels;
  return &recursive_rel_get_rels$(value);
}

::std::uint64_t lbug_rs$cxxbridge1$get_storage_version() noexcept {
  ::std::uint64_t (*get_storage_version$)() = ::lbug_rs::get_storage_version;
  return get_storage_version$();
}
} // extern "C"
} // namespace lbug_rs

extern "C" {
static_assert(::rust::detail::is_complete<::lbug::common::Value>::value, "definition of Value is required");
static_assert(sizeof(::std::unique_ptr<::lbug::common::Value>) == sizeof(void *), "");
static_assert(alignof(::std::unique_ptr<::lbug::common::Value>) == alignof(void *), "");
void cxxbridge1$unique_ptr$lbug$common$Value$null(::std::unique_ptr<::lbug::common::Value> *ptr) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug::common::Value>();
}
void cxxbridge1$unique_ptr$lbug$common$Value$raw(::std::unique_ptr<::lbug::common::Value> *ptr, ::lbug::common::Value *raw) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug::common::Value>(raw);
}
::lbug::common::Value const *cxxbridge1$unique_ptr$lbug$common$Value$get(::std::unique_ptr<::lbug::common::Value> const &ptr) noexcept {
  return ptr.get();
}
::lbug::common::Value *cxxbridge1$unique_ptr$lbug$common$Value$release(::std::unique_ptr<::lbug::common::Value> &ptr) noexcept {
  return ptr.release();
}
void cxxbridge1$unique_ptr$lbug$common$Value$drop(::std::unique_ptr<::lbug::common::Value> *ptr) noexcept {
  ::rust::deleter_if<::rust::detail::is_complete<::lbug::common::Value>::value>{}(ptr);
}

static_assert(::rust::detail::is_complete<::lbug_rs::QueryParams>::value, "definition of QueryParams is required");
static_assert(sizeof(::std::unique_ptr<::lbug_rs::QueryParams>) == sizeof(void *), "");
static_assert(alignof(::std::unique_ptr<::lbug_rs::QueryParams>) == alignof(void *), "");
void cxxbridge1$unique_ptr$lbug_rs$QueryParams$null(::std::unique_ptr<::lbug_rs::QueryParams> *ptr) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug_rs::QueryParams>();
}
void cxxbridge1$unique_ptr$lbug_rs$QueryParams$raw(::std::unique_ptr<::lbug_rs::QueryParams> *ptr, ::lbug_rs::QueryParams *raw) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug_rs::QueryParams>(raw);
}
::lbug_rs::QueryParams const *cxxbridge1$unique_ptr$lbug_rs$QueryParams$get(::std::unique_ptr<::lbug_rs::QueryParams> const &ptr) noexcept {
  return ptr.get();
}
::lbug_rs::QueryParams *cxxbridge1$unique_ptr$lbug_rs$QueryParams$release(::std::unique_ptr<::lbug_rs::QueryParams> &ptr) noexcept {
  return ptr.release();
}
void cxxbridge1$unique_ptr$lbug_rs$QueryParams$drop(::std::unique_ptr<::lbug_rs::QueryParams> *ptr) noexcept {
  ::rust::deleter_if<::rust::detail::is_complete<::lbug_rs::QueryParams>::value>{}(ptr);
}

static_assert(::rust::detail::is_complete<::lbug::main::Database>::value, "definition of Database is required");
static_assert(sizeof(::std::unique_ptr<::lbug::main::Database>) == sizeof(void *), "");
static_assert(alignof(::std::unique_ptr<::lbug::main::Database>) == alignof(void *), "");
void cxxbridge1$unique_ptr$lbug$main$Database$null(::std::unique_ptr<::lbug::main::Database> *ptr) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug::main::Database>();
}
void cxxbridge1$unique_ptr$lbug$main$Database$raw(::std::unique_ptr<::lbug::main::Database> *ptr, ::lbug::main::Database *raw) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug::main::Database>(raw);
}
::lbug::main::Database const *cxxbridge1$unique_ptr$lbug$main$Database$get(::std::unique_ptr<::lbug::main::Database> const &ptr) noexcept {
  return ptr.get();
}
::lbug::main::Database *cxxbridge1$unique_ptr$lbug$main$Database$release(::std::unique_ptr<::lbug::main::Database> &ptr) noexcept {
  return ptr.release();
}
void cxxbridge1$unique_ptr$lbug$main$Database$drop(::std::unique_ptr<::lbug::main::Database> *ptr) noexcept {
  ::rust::deleter_if<::rust::detail::is_complete<::lbug::main::Database>::value>{}(ptr);
}

static_assert(::rust::detail::is_complete<::lbug::main::Connection>::value, "definition of Connection is required");
static_assert(sizeof(::std::unique_ptr<::lbug::main::Connection>) == sizeof(void *), "");
static_assert(alignof(::std::unique_ptr<::lbug::main::Connection>) == alignof(void *), "");
void cxxbridge1$unique_ptr$lbug$main$Connection$null(::std::unique_ptr<::lbug::main::Connection> *ptr) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug::main::Connection>();
}
void cxxbridge1$unique_ptr$lbug$main$Connection$raw(::std::unique_ptr<::lbug::main::Connection> *ptr, ::lbug::main::Connection *raw) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug::main::Connection>(raw);
}
::lbug::main::Connection const *cxxbridge1$unique_ptr$lbug$main$Connection$get(::std::unique_ptr<::lbug::main::Connection> const &ptr) noexcept {
  return ptr.get();
}
::lbug::main::Connection *cxxbridge1$unique_ptr$lbug$main$Connection$release(::std::unique_ptr<::lbug::main::Connection> &ptr) noexcept {
  return ptr.release();
}
void cxxbridge1$unique_ptr$lbug$main$Connection$drop(::std::unique_ptr<::lbug::main::Connection> *ptr) noexcept {
  ::rust::deleter_if<::rust::detail::is_complete<::lbug::main::Connection>::value>{}(ptr);
}

static_assert(::rust::detail::is_complete<::lbug::main::PreparedStatement>::value, "definition of PreparedStatement is required");
static_assert(sizeof(::std::unique_ptr<::lbug::main::PreparedStatement>) == sizeof(void *), "");
static_assert(alignof(::std::unique_ptr<::lbug::main::PreparedStatement>) == alignof(void *), "");
void cxxbridge1$unique_ptr$lbug$main$PreparedStatement$null(::std::unique_ptr<::lbug::main::PreparedStatement> *ptr) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug::main::PreparedStatement>();
}
void cxxbridge1$unique_ptr$lbug$main$PreparedStatement$raw(::std::unique_ptr<::lbug::main::PreparedStatement> *ptr, ::lbug::main::PreparedStatement *raw) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug::main::PreparedStatement>(raw);
}
::lbug::main::PreparedStatement const *cxxbridge1$unique_ptr$lbug$main$PreparedStatement$get(::std::unique_ptr<::lbug::main::PreparedStatement> const &ptr) noexcept {
  return ptr.get();
}
::lbug::main::PreparedStatement *cxxbridge1$unique_ptr$lbug$main$PreparedStatement$release(::std::unique_ptr<::lbug::main::PreparedStatement> &ptr) noexcept {
  return ptr.release();
}
void cxxbridge1$unique_ptr$lbug$main$PreparedStatement$drop(::std::unique_ptr<::lbug::main::PreparedStatement> *ptr) noexcept {
  ::rust::deleter_if<::rust::detail::is_complete<::lbug::main::PreparedStatement>::value>{}(ptr);
}

static_assert(::rust::detail::is_complete<::lbug::main::QueryResult>::value, "definition of QueryResult is required");
static_assert(sizeof(::std::unique_ptr<::lbug::main::QueryResult>) == sizeof(void *), "");
static_assert(alignof(::std::unique_ptr<::lbug::main::QueryResult>) == alignof(void *), "");
void cxxbridge1$unique_ptr$lbug$main$QueryResult$null(::std::unique_ptr<::lbug::main::QueryResult> *ptr) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug::main::QueryResult>();
}
void cxxbridge1$unique_ptr$lbug$main$QueryResult$raw(::std::unique_ptr<::lbug::main::QueryResult> *ptr, ::lbug::main::QueryResult *raw) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug::main::QueryResult>(raw);
}
::lbug::main::QueryResult const *cxxbridge1$unique_ptr$lbug$main$QueryResult$get(::std::unique_ptr<::lbug::main::QueryResult> const &ptr) noexcept {
  return ptr.get();
}
::lbug::main::QueryResult *cxxbridge1$unique_ptr$lbug$main$QueryResult$release(::std::unique_ptr<::lbug::main::QueryResult> &ptr) noexcept {
  return ptr.release();
}
void cxxbridge1$unique_ptr$lbug$main$QueryResult$drop(::std::unique_ptr<::lbug::main::QueryResult> *ptr) noexcept {
  ::rust::deleter_if<::rust::detail::is_complete<::lbug::main::QueryResult>::value>{}(ptr);
}

static_assert(sizeof(::std::shared_ptr<::lbug::processor::FlatTuple>) == 2 * sizeof(void *), "");
static_assert(alignof(::std::shared_ptr<::lbug::processor::FlatTuple>) == alignof(void *), "");
void cxxbridge1$shared_ptr$lbug$processor$FlatTuple$null(::std::shared_ptr<::lbug::processor::FlatTuple> *ptr) noexcept {
  ::new (ptr) ::std::shared_ptr<::lbug::processor::FlatTuple>();
}
void cxxbridge1$shared_ptr$lbug$processor$FlatTuple$clone(::std::shared_ptr<::lbug::processor::FlatTuple> const &self, ::std::shared_ptr<::lbug::processor::FlatTuple> *ptr) noexcept {
  ::new (ptr) ::std::shared_ptr<::lbug::processor::FlatTuple>(self);
}
::lbug::processor::FlatTuple const *cxxbridge1$shared_ptr$lbug$processor$FlatTuple$get(::std::shared_ptr<::lbug::processor::FlatTuple> const &self) noexcept {
  return self.get();
}
void cxxbridge1$shared_ptr$lbug$processor$FlatTuple$drop(::std::shared_ptr<::lbug::processor::FlatTuple> *self) noexcept {
  self->~shared_ptr();
}

::std::vector<::lbug::common::LogicalType> *cxxbridge1$std$vector$lbug$common$LogicalType$new() noexcept {
  return new ::std::vector<::lbug::common::LogicalType>();
}
::std::size_t cxxbridge1$std$vector$lbug$common$LogicalType$size(::std::vector<::lbug::common::LogicalType> const &s) noexcept {
  return s.size();
}
::lbug::common::LogicalType *cxxbridge1$std$vector$lbug$common$LogicalType$get_unchecked(::std::vector<::lbug::common::LogicalType> *s, ::std::size_t pos) noexcept {
  return &(*s)[pos];
}
static_assert(sizeof(::std::unique_ptr<::std::vector<::lbug::common::LogicalType>>) == sizeof(void *), "");
static_assert(alignof(::std::unique_ptr<::std::vector<::lbug::common::LogicalType>>) == alignof(void *), "");
void cxxbridge1$unique_ptr$std$vector$lbug$common$LogicalType$null(::std::unique_ptr<::std::vector<::lbug::common::LogicalType>> *ptr) noexcept {
  ::new (ptr) ::std::unique_ptr<::std::vector<::lbug::common::LogicalType>>();
}
void cxxbridge1$unique_ptr$std$vector$lbug$common$LogicalType$raw(::std::unique_ptr<::std::vector<::lbug::common::LogicalType>> *ptr, ::std::vector<::lbug::common::LogicalType> *raw) noexcept {
  ::new (ptr) ::std::unique_ptr<::std::vector<::lbug::common::LogicalType>>(raw);
}
::std::vector<::lbug::common::LogicalType> const *cxxbridge1$unique_ptr$std$vector$lbug$common$LogicalType$get(::std::unique_ptr<::std::vector<::lbug::common::LogicalType>> const &ptr) noexcept {
  return ptr.get();
}
::std::vector<::lbug::common::LogicalType> *cxxbridge1$unique_ptr$std$vector$lbug$common$LogicalType$release(::std::unique_ptr<::std::vector<::lbug::common::LogicalType>> &ptr) noexcept {
  return ptr.release();
}
void cxxbridge1$unique_ptr$std$vector$lbug$common$LogicalType$drop(::std::unique_ptr<::std::vector<::lbug::common::LogicalType>> *ptr) noexcept {
  ptr->~unique_ptr();
}

static_assert(::rust::detail::is_complete<::lbug::common::LogicalType>::value, "definition of LogicalType is required");
static_assert(sizeof(::std::unique_ptr<::lbug::common::LogicalType>) == sizeof(void *), "");
static_assert(alignof(::std::unique_ptr<::lbug::common::LogicalType>) == alignof(void *), "");
void cxxbridge1$unique_ptr$lbug$common$LogicalType$null(::std::unique_ptr<::lbug::common::LogicalType> *ptr) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug::common::LogicalType>();
}
void cxxbridge1$unique_ptr$lbug$common$LogicalType$raw(::std::unique_ptr<::lbug::common::LogicalType> *ptr, ::lbug::common::LogicalType *raw) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug::common::LogicalType>(raw);
}
::lbug::common::LogicalType const *cxxbridge1$unique_ptr$lbug$common$LogicalType$get(::std::unique_ptr<::lbug::common::LogicalType> const &ptr) noexcept {
  return ptr.get();
}
::lbug::common::LogicalType *cxxbridge1$unique_ptr$lbug$common$LogicalType$release(::std::unique_ptr<::lbug::common::LogicalType> &ptr) noexcept {
  return ptr.release();
}
void cxxbridge1$unique_ptr$lbug$common$LogicalType$drop(::std::unique_ptr<::lbug::common::LogicalType> *ptr) noexcept {
  ::rust::deleter_if<::rust::detail::is_complete<::lbug::common::LogicalType>::value>{}(ptr);
}

static_assert(::rust::detail::is_complete<::lbug_rs::TypeListBuilder>::value, "definition of TypeListBuilder is required");
static_assert(sizeof(::std::unique_ptr<::lbug_rs::TypeListBuilder>) == sizeof(void *), "");
static_assert(alignof(::std::unique_ptr<::lbug_rs::TypeListBuilder>) == alignof(void *), "");
void cxxbridge1$unique_ptr$lbug_rs$TypeListBuilder$null(::std::unique_ptr<::lbug_rs::TypeListBuilder> *ptr) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug_rs::TypeListBuilder>();
}
void cxxbridge1$unique_ptr$lbug_rs$TypeListBuilder$raw(::std::unique_ptr<::lbug_rs::TypeListBuilder> *ptr, ::lbug_rs::TypeListBuilder *raw) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug_rs::TypeListBuilder>(raw);
}
::lbug_rs::TypeListBuilder const *cxxbridge1$unique_ptr$lbug_rs$TypeListBuilder$get(::std::unique_ptr<::lbug_rs::TypeListBuilder> const &ptr) noexcept {
  return ptr.get();
}
::lbug_rs::TypeListBuilder *cxxbridge1$unique_ptr$lbug_rs$TypeListBuilder$release(::std::unique_ptr<::lbug_rs::TypeListBuilder> &ptr) noexcept {
  return ptr.release();
}
void cxxbridge1$unique_ptr$lbug_rs$TypeListBuilder$drop(::std::unique_ptr<::lbug_rs::TypeListBuilder> *ptr) noexcept {
  ::rust::deleter_if<::rust::detail::is_complete<::lbug_rs::TypeListBuilder>::value>{}(ptr);
}

static_assert(::rust::detail::is_complete<::lbug_rs::ValueListBuilder>::value, "definition of ValueListBuilder is required");
static_assert(sizeof(::std::unique_ptr<::lbug_rs::ValueListBuilder>) == sizeof(void *), "");
static_assert(alignof(::std::unique_ptr<::lbug_rs::ValueListBuilder>) == alignof(void *), "");
void cxxbridge1$unique_ptr$lbug_rs$ValueListBuilder$null(::std::unique_ptr<::lbug_rs::ValueListBuilder> *ptr) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug_rs::ValueListBuilder>();
}
void cxxbridge1$unique_ptr$lbug_rs$ValueListBuilder$raw(::std::unique_ptr<::lbug_rs::ValueListBuilder> *ptr, ::lbug_rs::ValueListBuilder *raw) noexcept {
  ::new (ptr) ::std::unique_ptr<::lbug_rs::ValueListBuilder>(raw);
}
::lbug_rs::ValueListBuilder const *cxxbridge1$unique_ptr$lbug_rs$ValueListBuilder$get(::std::unique_ptr<::lbug_rs::ValueListBuilder> const &ptr) noexcept {
  return ptr.get();
}
::lbug_rs::ValueListBuilder *cxxbridge1$unique_ptr$lbug_rs$ValueListBuilder$release(::std::unique_ptr<::lbug_rs::ValueListBuilder> &ptr) noexcept {
  return ptr.release();
}
void cxxbridge1$unique_ptr$lbug_rs$ValueListBuilder$drop(::std::unique_ptr<::lbug_rs::ValueListBuilder> *ptr) noexcept {
  ::rust::deleter_if<::rust::detail::is_complete<::lbug_rs::ValueListBuilder>::value>{}(ptr);
}
} // extern "C"
